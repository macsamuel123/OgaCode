import asyncio
import json
import sys
from pathlib import Path

import click
from rich.console import Console
from rich.panel import Panel

from ogacode.cache import usage_stats
from ogacode.keychain import get_api_key, set_api_key

console = Console()

_SUBCOMMANDS = frozenset({"setup", "doctor", "stats", "rollback"})


def main() -> None:
    """Entry point: routes free-text tasks directly, subcommands through Click."""
    args = sys.argv[1:]

    if not args or args[0] in ("--help", "-h"):
        _print_help()
        return

    # Extract flags first, then look at the remaining positional args
    stream   = "--stream"  in args
    json_out = "--json"    in args
    offline  = "--offline" in args
    plan     = "--plan"    in args

    positional = [a for a in args if not a.startswith("-")]
    first = positional[0] if positional else None

    # Known subcommand → delegate to Click group
    if not first or first in _SUBCOMMANDS:
        _cli(standalone_mode=True)
        return

    # Everything else is a free-text task
    task = " ".join(positional)
    asyncio.run(_run(task, Path.cwd(), stream=stream, json_output=json_out,
                     offline=offline, plan_mode=plan))


def _print_help() -> None:
    console.print("[bold]OgaCode[/] -- AI coding assistant for Nigerian developers.\n")
    console.print("  [cyan]ogacode \"build me a login page\"[/]   Run a task")
    console.print("  [cyan]ogacode setup[/]                      Configure API keys")
    console.print("  [cyan]ogacode doctor[/]                     Check provider connectivity")
    console.print("  [cyan]ogacode stats[/]                      Show data usage\n")
    console.print("  [cyan]ogacode rollback[/]                   Restore files from last run\n")
    console.print("Flags: --stream  --json  --offline  --plan")


async def _run(prompt: str, cwd: Path, *, stream: bool, json_output: bool,
               offline: bool, plan_mode: bool = False) -> None:
    from ogacode.agent.events import EventBus
    from ogacode.agent.listeners import make_audit_listener, make_console_listener
    from ogacode.agent.loop import agent_loop, create_plan

    if plan_mode:
        console.print(Panel(f"[bold cyan]OgaCode Plan[/] -- {prompt}", border_style="cyan", padding=(0, 1)))
        console.print("  [dim]Generating plan...[/]")
        plan = await create_plan(prompt)
        console.print(f"\n  [bold]{plan.summary}[/]\n")
        for i, step in enumerate(plan.steps, 1):
            console.print(f"  {i}. {step}")
        console.print()
        if not click.confirm("  Proceed with this plan?", default=True):
            console.print("  [dim]Cancelled.[/]")
            return

    bus = EventBus()
    bus.on_any(make_audit_listener())
    bus.on_any(make_console_listener(console, as_json=stream or json_output))

    if not (stream or json_output):
        console.print(Panel(f"[bold cyan]OgaCode[/] -- {prompt}", border_style="cyan", padding=(0, 1)))

    try:
        result = await agent_loop(task=prompt, cwd=cwd, bus=bus, offline=offline)

        if stream or json_output:
            print(json.dumps({
                "type": "complete",
                "msg": result.summary,
                "success": result.success,
                "files": result.files_written,
            }), flush=True)
        elif result.success:
            console.print(f"\n[bold green]Done:[/] {result.summary}")
            for f in result.files_written:
                console.print(f"  [dim]created:[/] {f}")
        else:
            console.print(f"\n[bold yellow]Warning:[/] {result.summary}")
            if result.error:
                console.print(f"  [dim]{result.error}[/]")

    except KeyboardInterrupt:
        if not (stream or json_output):
            console.print("\n[dim]Interrupted.[/]")
        sys.exit(1)
    except Exception as exc:
        _fail(str(exc), stream or json_output)


def _fail(msg: str, as_json: bool) -> None:
    if as_json:
        print(json.dumps({"type": "error", "msg": msg}), flush=True)
    else:
        console.print(f"\n[bold red]Error:[/] {msg}")
    sys.exit(1)


# ── Subcommands ────────────────────────────────────────────────────────────────

@click.group()
def _cli() -> None:
    pass


@_cli.command()
def setup() -> None:
    """Configure API keys -- stored in OS keychain, never in files."""
    console.print("[bold]OgaCode Setup[/]\n")
    for key_name, label, hint in [
        ("deepseek_api_key", "DeepSeek API key", "platform.deepseek.com -> API Keys"),
        ("groq_api_key",     "Groq API key",     "console.groq.com -> API Keys (free tier)"),
    ]:
        existing = get_api_key(key_name)
        if existing:
            if not click.confirm(f"  {label} already set. Overwrite?", default=False):
                continue
        key = click.prompt(f"  {label} ({hint})", hide_input=True)
        if key.strip():
            set_api_key(key_name, key.strip())
            console.print(f"  [green]OK[/] {label} saved\n")


@_cli.command()
def doctor() -> None:
    """Check connectivity to all LLM providers."""
    import httpx
    console.print("[bold]OgaCode Doctor[/]\n")
    for name, url, key_name in [
        ("DeepSeek", "https://api.deepseek.com/v1/models",    "deepseek_api_key"),
        ("Groq",     "https://api.groq.com/openai/v1/models", "groq_api_key"),
    ]:
        api_key = get_api_key(key_name)
        if not api_key:
            console.print(f"  [-] {name}: no API key  --  run [bold]ogacode setup[/]")
            continue
        try:
            r = httpx.get(url, headers={"Authorization": f"Bearer {api_key}"}, timeout=8)
            console.print(f"  [green]OK[/] {name}: connected" if r.status_code == 200 else f"  [red]FAIL[/] {name}: HTTP {r.status_code}")
        except Exception:
            console.print(f"  [red]FAIL[/] {name}: unreachable")
    try:
        r = httpx.get("http://localhost:11434/api/tags", timeout=3)
        if r.status_code == 200:
            console.print("  [green]OK[/] Ollama: running (offline mode available)")
    except Exception:
        console.print("  [-] Ollama: not running (optional)")


@_cli.command()
def rollback() -> None:
    """Restore files overwritten by the last OgaCode run."""
    snap_dir = Path.cwd() / ".ogacode" / "snapshots"
    if not snap_dir.exists():
        console.print("  [dim]No snapshots found in this directory.[/]")
        return
    backups = sorted(snap_dir.glob("*.bak"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not backups:
        console.print("  [dim]No backups found.[/]")
        return
    console.print(f"[bold]OgaCode Rollback[/] -- {len(backups)} snapshot(s) found\n")
    for b in backups[:10]:
        console.print(f"  [dim]{b.name}[/]")
    if not click.confirm("\n  Restore the most recent snapshot for each file?", default=False):
        return
    restored = 0
    seen: set[str] = set()
    for b in backups:
        # filename format: original_name.timestamp.bak
        parts = b.name.rsplit(".", 2)
        if len(parts) < 3:
            continue
        original_name = parts[0]
        if original_name in seen:
            continue
        seen.add(original_name)
        # Find the original file by searching the project
        candidates = list(Path.cwd().rglob(original_name))
        target = candidates[0] if candidates else Path.cwd() / original_name
        target.write_bytes(b.read_bytes())
        console.print(f"  [green]OK[/] Restored: {target.relative_to(Path.cwd())}")
        restored += 1
    console.print(f"\n  {restored} file(s) restored.")


@_cli.command()
@click.option("--reset", is_flag=True)
@click.option("--json", "json_output", is_flag=True)
def stats(reset: bool, json_output: bool) -> None:
    """Show data usage."""
    data = usage_stats(reset=reset)
    if json_output:
        print(json.dumps(data))
    else:
        console.print("[bold]OgaCode Stats[/]\n")
        console.print(f"  Requests    : {data['requests']}")
        console.print(f"  Data sent   : {data['bytes_used'] / 1024:.1f} KB")
        console.print(f"  Cache hits  : {data['cache_hits']}  ({data['cache_hit_pct']}% saved)")
        console.print(f"  Tokens sent : {data['tokens_sent']:,}")
        if reset:
            console.print("\n  [dim]Counters reset.[/]")

import asyncio
import json
import sys
from pathlib import Path

import click
from rich.console import Console
from rich.panel import Panel

from ogacode import __version__
from ogacode.cache import usage_stats
from ogacode.keychain import get_api_key, set_api_key

# Windows terminals default to cp1252 which can't encode the Unicode symbols
# used by Rich (▸, ✗, ↺, etc.). Force UTF-8 so they render correctly.
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

console = Console()

_SUBCOMMANDS = frozenset({"setup", "doctor", "stats", "rollback", "config", "flush", "memory", "rag"})


def main() -> None:
    args = sys.argv[1:]

    if not args or args[0] in ("--help", "-h"):
        _print_help()
        return

    if "--version" in args or "-V" in args:
        console.print(f"ogacode {__version__}")
        return

    stream   = "--stream"  in args
    json_out = "--json"    in args
    offline  = "--offline" in args
    plan     = "--plan"    in args

    # --task-file <path>: read task from a file (used by VS Code extension for long tasks)
    if '--task-file' in args:
        idx = args.index('--task-file')
        if idx + 1 < len(args):
            task = Path(args[idx + 1]).read_text(encoding='utf-8').strip()

            # --plan-only: generate plan, emit JSON, exit — no agent execution
            if '--plan-only' in args:
                import dataclasses
                from ogacode.agent.loop import create_plan_with_fallback
                p = asyncio.run(create_plan_with_fallback(task))
                print(json.dumps({
                    "type": "plan",
                    "summary": p.summary,
                    "steps": p.steps,
                    "components": [dataclasses.asdict(c) for c in p.components],
                    "step_details": [dataclasses.asdict(s) for s in p.step_details],
                    "is_default": p.is_default,
                }), flush=True)
                return

            # --merge: generate plan → wait for approval on stdin → execute in same process
            if '--merge' in args:
                import dataclasses
                from ogacode.agent.events import EventBus
                from ogacode.agent.listeners import make_audit_listener, make_console_listener
                from ogacode.agent.loop import agent_loop, create_plan

                p = asyncio.run(create_plan(task))
                print(json.dumps({
                    "type": "plan",
                    "summary": p.summary,
                    "steps": p.steps,
                    "components": [dataclasses.asdict(c) for c in p.components],
                    "step_details": [dataclasses.asdict(s) for s in p.step_details],
                    "is_default": p.is_default,
                }), flush=True)

                line = sys.stdin.readline()
                if not line:
                    return
                try:
                    approval = json.loads(line.strip())
                except json.JSONDecodeError:
                    return

                if approval.get("action") != "approve":
                    print(json.dumps({"type": "cancelled"}), flush=True)
                    return

                approved_steps = approval.get("steps")
                if approved_steps:
                    steps_text = "\n".join(f"{i+1}. {s}" for i, s in enumerate(approved_steps))
                    task = f"[APPROVED PLAN — follow these steps in order]\n{steps_text}\n[END PLAN]\n\n{task}"

                bus = EventBus()
                bus.on_any(make_audit_listener())
                bus.on_any(make_console_listener(console, as_json=True))

                result = asyncio.run(agent_loop(task=task, cwd=Path.cwd(), bus=bus))
                print(json.dumps({
                    "type": "complete",
                    "msg": result.summary,
                    "success": result.success,
                    "files": result.files_written,
                }), flush=True)
                return

            asyncio.run(_run(task, Path.cwd(), stream=stream, json_output=json_out,
                             offline=offline, plan_mode=plan))
            return

    positional = [a for a in args if not a.startswith("-")]
    first = positional[0] if positional else None

    if not first or first in _SUBCOMMANDS:
        _cli(standalone_mode=True)
        return

    task = " ".join(positional)
    asyncio.run(_run(task, Path.cwd(), stream=stream, json_output=json_out,
                     offline=offline, plan_mode=plan))


def _print_help() -> None:
    console.print("[bold]OgaCode[/] -- AI coding assistant for Nigerian developers.\n")
    console.print("  [cyan]ogacode \"build me a login page\"[/]   Run a task")
    console.print("  [cyan]ogacode setup[/]                      Configure API keys")
    console.print("  [cyan]ogacode doctor[/]                     Check provider connectivity")
    console.print("  [cyan]ogacode stats[/]                      Show data usage\n")
    console.print("  [cyan]ogacode rollback[/]                   Restore files from last run")
    console.print("  [cyan]ogacode config[/]                     Set monthly data cap (MB)")
    console.print("  [cyan]ogacode flush[/]                      Run tasks queued while offline")
    console.print("  [cyan]ogacode memory show[/]                Show project memory")
    console.print("  [cyan]ogacode memory set KEY VALUE[/]       Store a project fact")
    console.print("  [cyan]ogacode memory clear[/]               Wipe all memory for this project")
    console.print("  [cyan]ogacode rag status[/]                 Show RAG index stats for this project\n")
    console.print("Flags: --stream  --json  --offline  --plan  --version")


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
            console.print(f"\n[bold green]✓[/] [green]Done:[/] {result.summary}")
            for f in result.files_written:
                console.print(f"  [dim cyan]↳[/] [dim]{f}[/]")
        else:
            console.print(f"\n[bold yellow]Warning:[/] [yellow]{result.summary}[/]")
            if result.error:
                console.print(f"  [dim]{result.error[:200]}[/]")

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


@click.group()
def _cli() -> None:
    pass


@_cli.command()
def setup() -> None:
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
        key = key.strip()
        if not key:
            continue
        if len(key) < 20:
            console.print(f"  [red]Error:[/] {label} must be at least 20 characters (got {len(key)})\n")
            continue
        set_api_key(key_name, key)
        console.print(f"  [green]OK[/] {label} saved\n")


@_cli.command()
def doctor() -> None:
    import sys
    import httpx
    import keyring as _kr
    console.print("[bold]OgaCode Doctor[/]\n")

    # Python version
    ok_py = sys.version_info >= (3, 10)
    console.print(f"  {'[green]OK[/]' if ok_py else '[red]FAIL[/]'} Python {sys.version.split()[0]}" + ("" if ok_py else " — Python 3.10+ required"))

    # LLM provider keys
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

    # OgaCode managed server health
    server_url = os.environ.get("OGACODE_SERVER_URL", "").rstrip("/")
    if server_url:
        try:
            r = httpx.get(f"{server_url}/health", timeout=6)
            if r.status_code == 200:
                console.print(f"  [green]OK[/] Server reachable ({server_url})")
            else:
                console.print(f"  [red]FAIL[/] Server returned HTTP {r.status_code}")
        except Exception:
            console.print(f"  [red]FAIL[/] Server unreachable — check your internet connection")

        # Token validity
        token = _kr.get_password("ogacode", "token") or ""
        if token:
            console.print("  [green]OK[/] Token configured")
        else:
            console.print("  [-] Token not configured  --  run [bold]ogacode setup[/]")
    else:
        console.print("  [-] Server URL not set (OGACODE_SERVER_URL) — using local providers only")

    # Ollama
    try:
        r = httpx.get("http://localhost:11434/api/tags", timeout=3)
        if r.status_code == 200:
            console.print("  [green]OK[/] Ollama: running (offline mode available)")
    except Exception:
        console.print("  [-] Ollama: not running (optional)")


@_cli.command()
def rollback() -> None:
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
        # Backup format: <original_name>.<timestamp>.bak
        # Use rfind twice to strip .bak then .<timestamp>, preserving dots in the original name
        stem = b.name[: b.name.rfind(".")]   # strip .bak
        stem = stem[: stem.rfind(".")]        # strip .<timestamp>
        original_name = stem
        if not original_name:
            continue
        if original_name in seen:
            continue
        seen.add(original_name)
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


@_cli.command()
@click.argument("megabytes", type=int, required=False)
def config(megabytes: int | None) -> None:
    import tomllib
    from pathlib import Path

    config_dir = Path.home() / ".ogacode"
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / "config.toml"

    config: dict = {}
    if config_path.exists():
        raw = config_path.read_text()
        if raw.strip():
            config = tomllib.loads(raw)

    if megabytes is None:
        current = config.get("data_cap_mb", "not set")
        console.print("[bold]OgaCode Config[/]\n")
        console.print(f"  Monthly data cap: [cyan]{current}[/] MB")
        console.print("\n  Set it with: [bold]ogacode config 500[/]")
        return

    if megabytes < 0:
        console.print("  [red]Error:[/] Data cap must be a positive number (MB).")
        return

    config["data_cap_mb"] = megabytes
    try:
        import tomli_w
        config_path.write_text(tomli_w.dumps(config))
    except ImportError:
        config_path.write_text(f"data_cap_mb = {megabytes}\n")

    console.print(f"  [green]OK[/] Monthly data cap set to [cyan]{megabytes}[/] MB")
    console.print(f"  Saved to: [dim]{config_path}[/]")


@_cli.group()
def memory() -> None:
    """Manage per-project memory (stored in ~/.ogacode/projects/)."""
    pass


@memory.command("show")
@click.option("--json", "json_output", is_flag=True)
def memory_show(json_output: bool) -> None:
    """Show all facts and recent task history for the current project."""
    from ogacode import memory as pm
    cwd = Path.cwd()
    facts = pm.get_facts(cwd)
    log   = pm.get_task_log(cwd, limit=10)

    if json_output:
        print(json.dumps({"facts": facts, "task_log": log}))
        return

    console.print(f"[bold]Project Memory[/]  [dim]{cwd}[/]\n")
    if facts:
        console.print("[bold cyan]Facts[/]")
        by_cat: dict[str, list] = {}
        for f in facts:
            by_cat.setdefault(f["category"], []).append(f)
        for cat, items in by_cat.items():
            console.print(f"  [dim]{cat}[/]")
            for item in items:
                console.print(f"    [cyan]{item['key']}[/]: {item['value']}")
    else:
        console.print("  [dim]No facts stored yet.[/]")

    console.print()
    if log:
        console.print("[bold cyan]Recent Tasks[/]")
        for t in log:
            import datetime
            ts = datetime.datetime.fromtimestamp(t["logged_at"]).strftime("%Y-%m-%d %H:%M")
            console.print(f"  [dim]{ts}[/] {t['task'][:70]}")
            console.print(f"      [dim]→ {t['summary'][:90]}[/]")
    else:
        console.print("  [dim]No task history yet.[/]")


@memory.command("set")
@click.argument("key")
@click.argument("value")
@click.option("--category", "-c", default="general", show_default=True)
def memory_set(key: str, value: str, category: str) -> None:
    """Store a fact about this project."""
    from ogacode import memory as pm
    pm.set_fact(Path.cwd(), key, value, category)
    console.print(f"  [green]OK[/] [cyan]{key}[/] = {value}  [dim]({category})[/]")


@memory.command("delete")
@click.argument("key")
def memory_delete(key: str) -> None:
    """Remove a single fact by key."""
    from ogacode import memory as pm
    deleted = pm.delete_fact(Path.cwd(), key)
    if deleted:
        console.print(f"  [green]OK[/] Deleted [cyan]{key}[/]")
    else:
        console.print(f"  [yellow]Not found:[/] [cyan]{key}[/]")


@memory.command("clear")
@click.option("--yes", is_flag=True, help="Skip confirmation prompt.")
def memory_clear(yes: bool) -> None:
    """Wipe ALL memory (facts + task history) for the current project."""
    from ogacode import memory as pm
    cwd = Path.cwd()
    if not yes and not click.confirm(f"  Wipe all memory for {cwd}?", default=False):
        console.print("  [dim]Cancelled.[/]")
        return
    pm.clear(cwd)
    console.print("  [green]OK[/] Project memory cleared.")


@_cli.group()
def rag() -> None:
    """Manage the optional code RAG index (requires Ollama + nomic-embed-text)."""
    pass


@rag.command("status")
@click.option("--json", "json_output", is_flag=True)
def rag_status(json_output: bool) -> None:
    """Show how many files are indexed and whether Ollama is available."""
    import datetime
    from ogacode import rag as r
    data = r.status(Path.cwd())
    if json_output:
        print(json.dumps(data))
        return
    console.print("[bold]OgaCode RAG Status[/]\n")
    avail = "[green]yes[/]" if data["ollama_available"] else "[dim]no  (RAG disabled)[/]"
    console.print(f"  Ollama + model  : {avail}")
    console.print(f"  Embed model     : {data['embed_model']}  ({data['embed_model_mb']} MB)")
    console.print(f"  Files indexed   : {data['files_indexed']}")
    console.print(f"  Chunks indexed  : {data['chunks_indexed']}")
    if data["last_indexed_at"]:
        ts = datetime.datetime.fromtimestamp(data["last_indexed_at"]).strftime("%Y-%m-%d %H:%M:%S")
        console.print(f"  Last indexed    : {ts}")
    else:
        console.print("  Last indexed    : [dim]never[/]")
    if not data["ollama_available"]:
        console.print(
            "\n  To enable RAG: [bold]ollama pull nomic-embed-text[/]"
            "\n  Then keep Ollama running while using OgaCode."
        )


@_cli.command()
def flush() -> None:
    """Run tasks that were queued while offline."""
    import asyncio
    from ogacode.queue import list_pending, mark_done

    pending = list_pending()
    if not pending:
        console.print("  [dim]No queued tasks.[/]")
        return

    console.print(f"[bold]OgaCode Flush[/] -- {len(pending)} queued task(s)\n")
    for t in pending:
        console.print(f"  [dim]{t['queued_at'][:19]}[/]  [cyan]{t['task']}[/]  [dim](in {t['cwd']})[/]")

    if not click.confirm(f"\n  Run all {len(pending)} task(s) now?", default=True):
        return

    from ogacode.agent.events import EventBus
    from ogacode.agent.listeners import make_audit_listener, make_console_listener
    from ogacode.agent.loop import agent_loop

    for t in pending:
        console.print(Panel(f"[bold cyan]OgaCode[/] -- {t['task']}", border_style="cyan", padding=(0, 1)))
        bus = EventBus()
        bus.on_any(make_audit_listener())
        bus.on_any(make_console_listener(console))

        result = asyncio.run(agent_loop(task=t["task"], cwd=Path(t["cwd"]), bus=bus))
        if result.success:
            mark_done(t["id"])
            console.print(f"\n[bold green]✓[/] [green]Done:[/] {result.summary}\n")
        else:
            mark_done(t["id"], failed=True)
            console.print(f"\n[bold red]✗[/] Failed: {result.summary}\n")


if __name__ == '__main__':
    main()

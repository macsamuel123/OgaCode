import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from rich.console import Console

from ogacode.agent.events import (
    CORRECTION, ESCALATE, POST_TOOL, PRE_TOOL, PROVIDER, STOP, SUPERVISOR, THINKING,
)


def make_audit_listener(log_path: Path | None = None):
    """Appends every agent event to ~/.ogacode/audit.jsonl as newline-delimited JSON."""
    if log_path is None:
        log_path = Path.home() / ".ogacode" / "audit.jsonl"
    log_path.parent.mkdir(parents=True, exist_ok=True)

    def listener(event: dict[str, Any]) -> None:
        record = {"ts": datetime.now(timezone.utc).isoformat(), **event}
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")

    return listener


def make_console_listener(console: Console, *, as_json: bool = False):
    """
    Prints agent events to the terminal.
    In --stream / --json mode, emits raw JSON lines instead.
    """
    _current_provider: list[str] = [""]

    def listener(event: dict[str, Any]) -> None:
        t = event.get("type", "")

        if as_json:
            print(json.dumps(event), flush=True)
            return

        if t == THINKING:
            step = event.get("step", "?")
            console.print(f"  [dim]·[/] [dim]Thinking[/]  [dim](step {step})[/]")
        elif t == PROVIDER:
            _current_provider[0] = event.get("name", "")
        elif t == PRE_TOOL:
            args = event.get("args", {})
            arg_str = "  ".join(f"[dim]{k}[/]=[dim white]{v!r}[/]" for k, v in args.items())
            tool = event.get("tool", "")
            console.print(f"  [cyan]▸[/] [bold cyan]{tool}[/]  {arg_str}")
        elif t == POST_TOOL:
            if not event.get("success"):
                err = (event.get("error") or "failed")[:120]
                console.print(f"  [red]✗[/] [dim red]{err}[/]")
        elif t == CORRECTION:
            console.print(f"  [yellow]↺[/] [dim yellow]{event.get('msg', '')}[/]")
        elif t == SUPERVISOR:
            console.print(f"  [magenta]◈[/] [dim]{event.get('msg', '')}[/]")
        elif t == ESCALATE:
            console.print(f"  [bold yellow]?[/] {event.get('msg', '')}")

    return listener

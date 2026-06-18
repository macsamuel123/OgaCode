import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.text import Text

from ogacode.agent.events import (
    CORRECTION, ESCALATE, POST_TOOL, PRE_TOOL, PROVIDER, STOP, SUPERVISOR, THINKING,
)

_SPINNER_CHARS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
_SPINNER_SPEED = 0.12


def _spinner_frame() -> str:
    t = time.monotonic()
    idx = int(t / _SPINNER_SPEED) % len(_SPINNER_CHARS)
    return _SPINNER_CHARS[idx]


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
    In --stream / --json / --merge mode, emits raw JSON lines instead.
    """
    _state: dict[str, Any] = {"provider": "", "step": 0}

    def _clear_line() -> None:
        sys.stdout.write("\r\033[K")
        sys.stdout.flush()

    def _write_inline(text: str) -> None:
        sys.stdout.write(f"\r\033[K{text}")
        sys.stdout.flush()

    def listener(event: dict[str, Any]) -> None:
        t = event.get("type", "")

        if as_json:
            print(json.dumps(event), flush=True)
            return

        if t == PROVIDER:
            _state["provider"] = event.get("name", "")
            _write_inline(f"  📡 {_state['provider']}")
            time.sleep(0.15)
            _clear_line()
            return

        if t == THINKING:
            _state["step"] = event.get("step", 0)
            spinner = _spinner_frame()
            prov = _state["provider"]
            tag = f" [{prov}]" if prov else ""
            _write_inline(Text.from_markup(f"  {spinner} Thinking{tag}").plain)
            return

        if t == PRE_TOOL:
            tool = event.get("tool", "")
            args = event.get("args", {})
            hint = ""
            for k, v in args.items():
                if isinstance(v, str) and len(v) > 0:
                    hint = f" {k}={v[:80]!r}"
                    break
            _clear_line()
            console.print(f"  [cyan]▸[/] [bold cyan]{tool}[/]{hint}")
            return

        if t == POST_TOOL:
            tool = event.get("tool", "")
            ok = event.get("success", False)
            if ok:
                output = (event.get("output") or "")[:100]
                snippet = f" [dim]→ {output.strip()[:80]}[/]" if output else ""
                console.print(f"  [green]✅[/] [dim]{tool}[/]{snippet}")
            else:
                err = (event.get("error") or "no output")[:120]
                console.print(f"  [red]❌[/] [dim red]{err}[/]")
            return

        if t == CORRECTION:
            console.print(f"  [yellow]↺[/] [dim yellow]{event.get('msg', '')}[/]")
            return

        if t == SUPERVISOR:
            console.print(f"  [magenta]◈[/] [dim]{event.get('msg', '')}[/]")
            return

        if t == ESCALATE:
            console.print(f"  [bold yellow]?[/] {event.get('msg', '')}")
            return

        if t == STOP:
            _clear_line()
            ok = event.get("success", False)
            summary = event.get("summary", "")
            step_count = event.get("steps", 0)
            files = event.get("files", [])
            icon = "[green]✅[/]" if ok else "[yellow]⚠️[/]"
            console.print(f"  {icon} [bold]{summary}[/] [dim]({step_count} steps)[/]")
            for f in files:
                console.print(f"    [dim cyan]↳[/] [dim]{f}[/]")
            return

    return listener

"""
Task trace logger — writes full (prompt → plan → tool calls → outcome) records
to ~/.ogacode/traces/YYYY-MM-DD.jsonl for future model fine-tuning.

Each line is one JSON object (one completed task).
Sensitive content (file bodies, secrets) is never written — only metadata.
Sync to a training server is NOT done here; local accumulation only.
Opt-in gating for any future sync lives in config.toml (telemetry.opt_in).
"""

import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ogacode.agent.events import (
    EventBus, NARRATIVE, POST_TOOL, PRE_TOOL, STOP,
)

_TRACES_DIR = Path.home() / ".ogacode" / "traces"

_REDACT_KEYS = frozenset({"password", "token", "secret", "key", "api_key", "auth"})


def _safe_args(tool: str, args: dict[str, Any]) -> dict[str, Any]:
    """Strip large or sensitive fields from tool args before logging."""
    out: dict[str, Any] = {}
    for k, v in args.items():
        if k in _REDACT_KEYS or (isinstance(v, str) and len(v) > 300):
            continue
        out[k] = v
    return out


class Tracer:
    """
    Attaches to an EventBus and accumulates a structured trace.
    Writes to disk when the STOP event fires.
    """

    def __init__(self, task: str, cwd: Path) -> None:
        self._task = task[:500]
        self._cwd_hash = hashlib.sha256(str(cwd).encode()).hexdigest()[:16]
        self._start_ms = int(time.time() * 1000)
        self._plan: list[str] = []
        self._tool_calls: list[dict[str, Any]] = []
        self._pending_tool: dict[str, Any] | None = None
        self._narratives: list[str] = []

    def set_plan(self, steps: list[str]) -> None:
        self._plan = [s[:120] for s in steps]

    def attach(self, bus: EventBus) -> None:
        bus.on(PRE_TOOL,  self._on_pre_tool)
        bus.on(POST_TOOL, self._on_post_tool)
        bus.on(NARRATIVE, self._on_narrative)
        bus.on(STOP,      self._on_stop)

    # ── EventBus listeners ────────────────────────────────────────────────────

    def _on_pre_tool(self, ev: dict[str, Any]) -> None:
        self._pending_tool = {
            "tool": ev.get("tool", ""),
            "args": _safe_args(ev.get("tool", ""), ev.get("args") or {}),
        }

    def _on_post_tool(self, ev: dict[str, Any]) -> None:
        if self._pending_tool is None:
            return
        entry = dict(self._pending_tool)
        entry["success"] = ev.get("success", False)
        diff = ev.get("diff")
        if diff:
            entry["diff_stat"] = diff.get("stat", "")
            entry["is_new_file"] = diff.get("is_new", False)
        if not ev.get("success") and ev.get("error"):
            entry["error"] = str(ev["error"])[:120]
        self._tool_calls.append(entry)
        self._pending_tool = None

    def _on_narrative(self, ev: dict[str, Any]) -> None:
        text = (ev.get("text") or "").strip()
        if text:
            self._narratives.append(text[:200])

    def _on_stop(self, ev: dict[str, Any]) -> None:
        elapsed_ms = int(time.time() * 1000) - self._start_ms
        files = [str(f) for f in (ev.get("files") or [])]

        record: dict[str, Any] = {
            "ts":          datetime.now(timezone.utc).isoformat(),
            "cwd_hash":    self._cwd_hash,
            "task":        self._task,
            "plan":        self._plan,
            "tool_calls":  self._tool_calls,
            "narratives":  self._narratives[:10],
            "files_written": files[:20],
            "outcome":     "success" if ev.get("success") else "failure",
            "steps":       ev.get("steps", len(self._tool_calls)),
            "elapsed_ms":  elapsed_ms,
        }

        self._write(record)

    # ── Disk write ────────────────────────────────────────────────────────────

    def _write(self, record: dict[str, Any]) -> None:
        try:
            _TRACES_DIR.mkdir(parents=True, exist_ok=True)
            date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            path = _TRACES_DIR / f"{date_str}.jsonl"
            with path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        except Exception:
            pass  # trace write failure must never affect the agent

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_AUDIT_LOG = Path.home() / ".ogacode" / "logs" / "audit.log"
_AUDIT_MAX_LINES = 100


def _write_audit(tool_name: str, kwargs: dict) -> None:
    try:
        _AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
        truncated = {k: (v[:120] if isinstance(v, str) else v) for k, v in kwargs.items()}
        entry = json.dumps({"t": int(time.time()), "tool": tool_name, "input": truncated})
        lines = []
        if _AUDIT_LOG.exists():
            lines = _AUDIT_LOG.read_text(encoding="utf-8").splitlines()
        lines.append(entry)
        lines = lines[-_AUDIT_MAX_LINES:]
        _AUDIT_LOG.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except Exception:
        pass  # audit failures must never crash a tool


@dataclass
class ToolResult:
    success: bool
    output: str
    error: str = ""


class Tool:
    name: str
    description: str
    parameters: dict  # JSON Schema

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        original = cls.__dict__.get("execute")
        if original is None:
            return

        def _audited(self: "Tool", **kw: Any) -> ToolResult:
            _write_audit(self.name, kw)
            return original(self, **kw)

        cls.execute = _audited  # type: ignore[method-assign]

    def execute(self, **kwargs: Any) -> ToolResult:
        raise NotImplementedError

    def estimate_data_cost(self, **kwargs: Any) -> int:
        """Estimated bytes this call adds to the LLM context."""
        return len(str(kwargs).encode())

    def to_openai_schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

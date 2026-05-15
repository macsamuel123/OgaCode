import time
from pathlib import Path
from typing import Any

from ogacode.tools.base import Tool, ToolResult


class FileEditTool(Tool):
    name = "file_edit"
    description = (
        "Create, read, or append to a file in the project directory. "
        "Use 'read' to inspect existing files before editing."
    )
    parameters = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["create", "read", "append"],
                "description": "create: write/overwrite file, read: read file content, append: add to end",
            },
            "path": {"type": "string", "description": "File path relative to project root"},
            "content": {"type": "string", "description": "Content to write (required for create/append)"},
        },
        "required": ["action", "path"],
    }

    def __init__(self, cwd: Path) -> None:
        self._cwd = cwd

    def execute(self, action: str, path: str, content: str = "", **_: Any) -> ToolResult:
        target = (self._cwd / path).resolve()

        # Sandbox: block any path that escapes the project root
        try:
            target.relative_to(self._cwd.resolve())
        except ValueError:
            return ToolResult(success=False, output="", error=f"'{path}' is outside the project directory.")

        if action == "read":
            try:
                text = target.read_text(encoding="utf-8", errors="replace")
                return ToolResult(success=True, output=text[:8000])  # cap at 8KB
            except FileNotFoundError:
                return ToolResult(success=False, output="", error=f"File not found: {path}")
            except Exception as exc:
                return ToolResult(success=False, output="", error=str(exc))

        if action in ("create", "append"):
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                if action == "create":
                    self._snapshot(target)
                    target.write_text(content, encoding="utf-8")
                else:
                    with target.open("a", encoding="utf-8") as fh:
                        fh.write(content)
                verb = "Written" if action == "create" else "Appended"
                return ToolResult(success=True, output=f"{verb}: {path} ({len(content)} bytes)")
            except Exception as exc:
                return ToolResult(success=False, output="", error=str(exc))

        return ToolResult(success=False, output="", error=f"Unknown action: {action}")

    def _snapshot(self, target: Path) -> None:
        if not target.exists():
            return
        snap_dir = self._cwd / ".ogacode" / "snapshots"
        snap_dir.mkdir(parents=True, exist_ok=True)
        dest = snap_dir / f"{target.name}.{int(time.time())}.bak"
        dest.write_bytes(target.read_bytes())
        # Keep only the 10 most recent snapshots per filename
        old = sorted(snap_dir.glob(f"{target.name}.*.bak"))[:-10]
        for f in old:
            f.unlink(missing_ok=True)

    def estimate_data_cost(self, action: str = "", content: str = "", **_: Any) -> int:
        return len(content.encode()) if action in ("create", "append") else 200

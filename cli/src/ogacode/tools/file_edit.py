import time
from pathlib import Path
from typing import Any

from ogacode.tools.base import Tool, ToolResult

_BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".pdf", ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".pyc",
    ".mp3", ".mp4", ".wav", ".ogg", ".avi", ".mov",
}


def _is_binary(sample: bytes) -> bool:
    """Heuristic: if more than 30% of the first 512 bytes are non-printable, treat as binary."""
    if not sample:
        return False
    non_text = sum(1 for b in sample if b < 9 or (13 < b < 32))
    return non_text / len(sample) > 0.30


class FileEditTool(Tool):
    name = "file_edit"
    description = (
        "Create, read, edit, or append files in the project directory.\n"
        "- 'read'   : always read a file before editing it\n"
        "- 'edit'   : replace an exact string in an existing file (preferred for changes)\n"
        "- 'create' : write a brand-new file (overwrites if exists)\n"
        "- 'append' : add content to the end of a file"
    )
    parameters = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["create", "read", "append", "edit"],
                "description": (
                    "read: inspect file before changing it | "
                    "edit: replace old_string with new_string (targeted, preferred) | "
                    "create: write entire new file | "
                    "append: add to end"
                ),
            },
            "path": {
                "type": "string",
                "description": "File path relative to project root",
            },
            "content": {
                "type": "string",
                "description": "Full content (required for create/append)",
            },
            "old_string": {
                "type": "string",
                "description": "Exact string to find and replace (required for edit). Must be unique in the file.",
            },
            "new_string": {
                "type": "string",
                "description": "Replacement string (required for edit). Can be empty to delete old_string.",
            },
        },
        "required": ["action", "path"],
    }

    def __init__(self, cwd: Path) -> None:
        self._cwd = cwd

    def execute(
        self,
        action: str,
        path: str,
        content: str = "",
        old_string: str = "",
        new_string: str = "",
        **_: Any,
    ) -> ToolResult:
        target = (self._cwd / path).resolve()

        try:
            target.relative_to(self._cwd.resolve())
        except ValueError:
            return ToolResult(success=False, output="", error=f"'{path}' is outside the project directory.")

        if action == "read":
            try:
                raw = target.read_bytes()
                # Reject binary files — sending them to the LLM corrupts the conversation
                if b"\x00" in raw[:8192] or _is_binary(raw[:512]):
                    return ToolResult(success=False, output="",
                                      error=f"'{path}' is a binary file (image/font/compiled). Cannot read it.")
                text = raw.decode("utf-8", errors="replace")
                return ToolResult(success=True, output=text[:4000])
            except FileNotFoundError:
                return ToolResult(success=False, output="", error=f"File not found: {path}")
            except Exception as exc:
                return ToolResult(success=False, output="", error=str(exc))

        if action == "edit":
            if not old_string:
                return ToolResult(success=False, output="", error="edit requires old_string.")
            try:
                text = target.read_text(encoding="utf-8", errors="replace")
            except FileNotFoundError:
                return ToolResult(success=False, output="", error=f"File not found: {path} — use 'read' first.")

            count = text.count(old_string)
            if count == 0:
                return ToolResult(
                    success=False, output="",
                    error=f"old_string not found in {path}. Read the file first to get the exact content.",
                )
            if count > 1:
                return ToolResult(
                    success=False, output="",
                    error=f"old_string matches {count} locations in {path}. Add more surrounding context to make it unique.",
                )

            self._snapshot(target)
            updated = text.replace(old_string, new_string, 1)
            target.write_text(updated, encoding="utf-8")
            delta = len(new_string) - len(old_string)
            sign = "+" if delta >= 0 else ""
            return ToolResult(success=True, output=f"Edited: {path} ({sign}{delta} chars)")

        if action in ("create", "append"):
            if target.suffix.lower() in _BINARY_EXTENSIONS:
                return ToolResult(success=False, output="",
                                  error=f"Cannot create binary file '{path}'. Use text formats only.")
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
        old = sorted(snap_dir.glob(f"{target.name}.*.bak"))[:-10]
        for f in old:
            f.unlink(missing_ok=True)

    def estimate_data_cost(self, action: str = "", content: str = "", old_string: str = "", new_string: str = "", **_: Any) -> int:
        if action == "edit":
            return len(old_string.encode()) + len(new_string.encode())
        return len(content.encode()) if action in ("create", "append") else 200

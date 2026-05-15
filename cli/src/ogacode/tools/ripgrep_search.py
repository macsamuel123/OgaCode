import re
import subprocess
from pathlib import Path
from typing import Any

from ogacode.tools.base import Tool, ToolResult

_SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".venv", "dist", ".next"}


class RipgrepSearchTool(Tool):
    name = "ripgrep_search"
    description = (
        "Search for text or regex patterns across project files. "
        "Works fully offline. Returns file:line: content for each match."
    )
    parameters = {
        "type": "object",
        "properties": {
            "pattern": {"type": "string", "description": "Search pattern (regex supported)"},
            "path": {"type": "string", "description": "Sub-directory to search (default: project root)"},
            "file_glob": {"type": "string", "description": "File type filter, e.g. '*.py' or '*.ts'"},
            "case_sensitive": {"type": "boolean", "default": False},
        },
        "required": ["pattern"],
    }

    def __init__(self, cwd: Path) -> None:
        self._cwd = cwd

    def execute(
        self,
        pattern: str,
        path: str = ".",
        file_glob: str = "",
        case_sensitive: bool = False,
        **_: Any,
    ) -> ToolResult:
        search_root = (self._cwd / path).resolve()
        try:
            search_root.relative_to(self._cwd.resolve())
        except ValueError:
            search_root = self._cwd

        if self._rg_available():
            return self._rg(pattern, search_root, file_glob, case_sensitive)
        return self._python(pattern, search_root, file_glob, case_sensitive)

    def _rg_available(self) -> bool:
        try:
            subprocess.run(["rg", "--version"], capture_output=True, timeout=2)
            return True
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False

    def _rg(self, pattern: str, root: Path, file_glob: str, case_sensitive: bool) -> ToolResult:
        args = ["rg", "--line-number", "--no-heading", "--max-count", "3"]
        if not case_sensitive:
            args.append("--ignore-case")
        if file_glob:
            args += ["--glob", file_glob]
        args += [pattern, str(root)]
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=10, cwd=str(self._cwd))
            lines = result.stdout.strip().split("\n")[:50]
            return ToolResult(success=True, output="\n".join(lines) if any(lines) else "No matches found.")
        except subprocess.TimeoutExpired:
            return ToolResult(success=False, output="", error="Search timed out.")

    def _python(self, pattern: str, root: Path, file_glob: str, case_sensitive: bool) -> ToolResult:
        try:
            flags = 0 if case_sensitive else re.IGNORECASE
            rx = re.compile(pattern, flags)
        except re.error as exc:
            return ToolResult(success=False, output="", error=f"Invalid regex: {exc}")

        results: list[str] = []
        glob = file_glob or "**/*"
        for fp in root.glob(glob):
            if not fp.is_file():
                continue
            if any(skip in fp.parts for skip in _SKIP_DIRS):
                continue
            try:
                for i, line in enumerate(fp.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
                    if rx.search(line):
                        rel = fp.relative_to(self._cwd)
                        results.append(f"{rel}:{i}: {line.strip()[:120]}")
                        if len(results) >= 50:
                            break
            except Exception:
                continue
            if len(results) >= 50:
                break

        return ToolResult(success=True, output="\n".join(results) if results else "No matches found.")

    def estimate_data_cost(self, **_: Any) -> int:
        return 300

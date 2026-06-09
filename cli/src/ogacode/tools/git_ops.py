import subprocess
from pathlib import Path
from typing import Any

from ogacode.tools.base import Tool, ToolResult


class GitOpsTool(Tool):
    name = "git_ops"
    description = (
        "Git operations: status, diff, add, commit, push. "
        "Always run status before add. Always run add before commit. "
        "Never force-push."
    )
    parameters = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["status", "diff", "add", "commit", "push"],
                "description": "Git operation to perform",
            },
            "message": {
                "type": "string",
                "description": "Commit message (required when action='commit')",
            },
            "file": {
                "type": "string",
                "description": "File path (optional — defaults to all files)",
            },
        },
        "required": ["action"],
    }

    def __init__(self, cwd: Path) -> None:
        self._cwd = cwd

    def execute(self, action: str, message: str = "", file: str = "", **_: Any) -> ToolResult:
        try:
            if action == "status":
                out = self._run(["git", "status", "--short"])
                return ToolResult(success=True, output=out or "Nothing to commit, working tree clean")

            if action == "diff":
                cmd = ["git", "diff"]
                if file:
                    cmd.append(file)
                out = self._run(cmd)
                return ToolResult(success=True, output=out or "No unstaged changes")

            if action == "add":
                target = file or "."
                self._run(["git", "add", target])
                staged = self._run(["git", "diff", "--cached", "--name-only"])
                if not staged.strip():
                    return ToolResult(success=False, output="", error="Nothing staged after git add — are there any changes?")
                return ToolResult(success=True, output=f"Staged:\n{staged.strip()}")

            if action == "commit":
                if not message:
                    return ToolResult(success=False, output="", error="commit requires a message= argument")
                staged = self._run(["git", "diff", "--cached", "--name-only"])
                if not staged.strip():
                    return ToolResult(success=False, output="",
                                      error="Nothing staged. Run git_ops(action='add') first.")
                self._run(["git", "commit", "-m", message])
                short_hash = self._run(["git", "rev-parse", "--short", "HEAD"]).strip()
                return ToolResult(success=True, output=f"Committed {short_hash}: {message}")

            if action == "push":
                branch = self._run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).strip()
                # Check if upstream is configured
                try:
                    ahead = self._run(["git", "rev-list", f"origin/{branch}..HEAD"]).strip()
                except subprocess.CalledProcessError:
                    # No upstream set — push and set it
                    self._run(["git", "push", "--set-upstream", "origin", branch])
                    return ToolResult(success=True, output=f"Pushed new branch '{branch}' to origin")
                if not ahead:
                    return ToolResult(success=False, output="",
                                      error="No commits to push — nothing ahead of origin.")
                self._run(["git", "push", "origin", branch])
                count = len(ahead.splitlines())
                return ToolResult(success=True, output=f"Pushed {count} commit(s) to origin/{branch}")

            return ToolResult(success=False, output="", error=f"Unknown action: {action!r}")

        except subprocess.CalledProcessError as exc:
            stderr = (exc.stderr or "").strip()
            return ToolResult(success=False, output="", error=f"git error: {stderr or str(exc)}")
        except Exception as exc:
            return ToolResult(success=False, output="", error=str(exc))

    def _run(self, cmd: list[str]) -> str:
        result = subprocess.run(
            cmd,
            cwd=str(self._cwd),
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout

    def estimate_data_cost(self, action: str = "", **_: Any) -> int:
        # diff can be large; others are small
        return 2000 if action == "diff" else 300

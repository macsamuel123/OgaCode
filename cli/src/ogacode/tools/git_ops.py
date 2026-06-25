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
            if action in ("add", "commit", "push"):
                preflight = self._ensure_repo()
                if preflight is not None:
                    return preflight

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
            sl = stderr.lower()
            if "not a git repository" in sl:
                error_type = "git_not_initialized"
                msg = "Not a git repository. git init ran but may have failed — retry git_ops(action='status')."
            elif "conflict" in sl:
                error_type = "merge_conflict"
                msg = f"Merge conflict detected. Resolve conflicts then re-add: {stderr}"
            elif "nothing to commit" in sl or "nothing added to commit" in sl:
                error_type = "nothing_to_commit"
                msg = "Nothing to commit — working tree is clean."
            else:
                error_type = "git_command_failed"
                msg = f"git error: {stderr or str(exc)}"
            return ToolResult(success=False, output="", error=msg, error_type=error_type)
        except Exception as exc:
            return ToolResult(success=False, output="", error=str(exc), error_type="git_command_failed")

    def _ensure_repo(self) -> "ToolResult | None":
        """Return None if cwd is the ROOT of its own git repo (or was just init'd); ToolResult on failure.

        Intentionally treats directories nested inside a parent repo
        (e.g. extension/paystack-api/ inside the OgaCode repo) the same as
        no-repo-at-all: runs git init so commits go to this project's own
        history, not the parent's.
        """
        if self._is_repo_root():
            return None
        try:
            self._run(["git", "init"])
            return None
        except subprocess.CalledProcessError as exc:
            return ToolResult(
                success=False, output="",
                error=f"Not a git repository and git init failed: {(exc.stderr or '').strip()}",
                error_type="git_not_initialized",
            )

    def _is_repo_root(self) -> bool:
        """True only if cwd is the root directory of a git repo — not merely nested inside one."""
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--show-toplevel"],
                cwd=str(self._cwd),
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                return False
            return Path(result.stdout.strip()).resolve() == Path(self._cwd).resolve()
        except Exception:
            return False

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

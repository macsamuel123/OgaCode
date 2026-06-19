# WARNING: This is NOT a security sandbox. The banned list prevents accidents,
# not attacks. Do not run on sensitive machines without additional containerization.

import platform
import re
import subprocess
from pathlib import Path
from typing import Any

from ogacode.tools.base import Tool, ToolResult

_IS_WINDOWS = platform.system() == "Windows"

# Commands that could wipe the machine — never run regardless of LLM instruction
_BANNED = frozenset([
    "rm", "rmdir", "del", "format",
    "mkfs", "dd", "shutdown", "reboot", "poweroff", "init",
    "curl", "wget",                         # pipe-to-shell fetch vectors
    "kill",                                 # process killing (use specific PIDs if needed)
    "chmod", "chown",                       # permission escalation
])

# Patterns blocked regardless of which token they appear in
_BANNED_PATTERNS = [
    re.compile(r":\(\)\s*\{"),             # fork bomb: :(){
    re.compile(r"\|\s*ba?sh"),             # pipe-to-shell: curl ... | bash
    re.compile(r"\|\s*sh\b"),              # pipe-to-shell: ... | sh
    re.compile(r"python\s+-c\b"),          # inline python execution
    re.compile(r"perl\s+-e\b"),            # inline perl execution
    re.compile(r"mv\s+/\*"),               # wipe root: mv /*
    re.compile(r"cp\s+/\*"),               # wipe root: cp /*
    re.compile(r"chmod\s+-R\s+777"),       # world-writable recursion
    re.compile(r"kill\s+-9"),              # SIGKILL
    re.compile(r"\binit\s+[06]\b"),        # init 0 / init 6 (halt/reboot)
]


class BashExecTool(Tool):
    name = "bash"
    description = (
        "Execute a shell command in the project directory. "
        "Sandboxed: cannot navigate outside the project. Timeout: 30s."
    )
    parameters = {
        "type": "object",
        "properties": {
            "cmd": {"type": "string", "description": "Shell command to run"},
            "expect": {"type": "string", "description": "Optional string that MUST appear in output. If provided and missing, the tool returns failure."},
        },
        "required": ["cmd"],
    }

    def __init__(self, cwd: Path) -> None:
        self._cwd = cwd

    def execute(self, cmd: str | None = None, expect: str = "", **_: Any) -> ToolResult:
        if not cmd or not isinstance(cmd, str):
            return ToolResult(success=False, output="", error="bash_exec requires a 'cmd' string argument.")
        first_token = cmd.strip().split()[0] if cmd.strip() else ""
        if first_token in _BANNED:
            return ToolResult(success=False, output="", error=f"'{first_token}' is blocked for safety.")
        for pat in _BANNED_PATTERNS:
            if pat.search(cmd):
                return ToolResult(success=False, output="", error=f"Blocked pattern detected: {pat.pattern!r}")
        if "cd .." in cmd or "../" in cmd:
            return ToolResult(success=False, output="", error="Cannot navigate outside the project directory.")

        try:
            if _IS_WINDOWS:
                # PS 5.1 doesn't support &&; replace with ; so chained commands work
                cmd = cmd.replace(" && ", "; ").replace("&&", "; ")
                run_cmd: list | str = ["powershell", "-NonInteractive", "-Command", cmd]
                use_shell = False
            else:
                run_cmd = cmd
                use_shell = True

            proc = subprocess.run(
                run_cmd,
                shell=use_shell,
                cwd=str(self._cwd),
                capture_output=True,
                text=True,
                timeout=30,
            )
            output = (proc.stdout + proc.stderr).strip()
            if proc.returncode != 0:
                return ToolResult(success=False, output=output[:4000],
                                  error=f"exit code {proc.returncode}")
            if expect and expect not in output:
                return ToolResult(success=False, output=output[:4000],
                                  error=f"Expected {expect!r} in output but got: {output[:200]}")
            return ToolResult(success=True, output=output[:4000])
        except subprocess.TimeoutExpired:
            return ToolResult(success=False, output="", error="Command timed out after 30s.")
        except Exception as exc:
            return ToolResult(success=False, output="", error=str(exc))

    def estimate_data_cost(self, cmd: str = "", **_: Any) -> int:
        return len(cmd.encode()) + 500

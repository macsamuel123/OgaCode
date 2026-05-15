import platform
import subprocess
from pathlib import Path
from typing import Any

from ogacode.tools.base import Tool, ToolResult

_IS_WINDOWS = platform.system() == "Windows"

# Commands that could wipe the machine — never run regardless of LLM instruction
_BANNED = frozenset(["rm", "rmdir", "del", "format", "mkfs", "dd", "shutdown", "reboot", "poweroff"])


class BashExecTool(Tool):
    name = "bash_exec"
    description = (
        "Execute a shell command in the project directory. "
        "Sandboxed: cannot navigate outside the project. Timeout: 30s."
    )
    parameters = {
        "type": "object",
        "properties": {
            "cmd": {"type": "string", "description": "Shell command to run"},
        },
        "required": ["cmd"],
    }

    def __init__(self, cwd: Path) -> None:
        self._cwd = cwd

    def execute(self, cmd: str, **_: Any) -> ToolResult:
        first_token = cmd.strip().split()[0] if cmd.strip() else ""
        if first_token in _BANNED:
            return ToolResult(success=False, output="", error=f"'{first_token}' is blocked for safety.")
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
            return ToolResult(
                success=proc.returncode == 0,
                output=output[:4000],  # cap at 4KB to save LLM context
                error="" if proc.returncode == 0 else f"exit code {proc.returncode}",
            )
        except subprocess.TimeoutExpired:
            return ToolResult(success=False, output="", error="Command timed out after 30s.")
        except Exception as exc:
            return ToolResult(success=False, output="", error=str(exc))

    def estimate_data_cost(self, cmd: str = "", **_: Any) -> int:
        return len(cmd.encode()) + 500

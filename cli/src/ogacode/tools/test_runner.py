import subprocess
from pathlib import Path
from typing import Any

from ogacode.tools.base import Tool, ToolResult


class TestRunnerTool(Tool):
    name = "test_runner"
    description = "Run the project's test suite. Auto-detects pytest, npm test, or cargo test."
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Sub-directory to run tests in (default: project root)"},
            "filter": {"type": "string", "description": "Test name filter / pattern"},
        },
        "required": [],
    }

    def __init__(self, cwd: Path) -> None:
        self._cwd = cwd

    def execute(self, path: str = ".", filter: str = "", **_: Any) -> ToolResult:
        run_dir = (self._cwd / path).resolve()
        cmd = self._detect(run_dir, filter)
        if not cmd:
            return ToolResult(
                success=False, output="",
                error="No test runner found. Expected: pytest, npm test, or cargo test.",
            )
        try:
            proc = subprocess.run(cmd, shell=True, cwd=str(run_dir), capture_output=True, text=True, timeout=60)
            output = (proc.stdout + proc.stderr).strip()[:4000]
            return ToolResult(success=proc.returncode == 0, output=output)
        except subprocess.TimeoutExpired:
            return ToolResult(success=False, output="", error="Tests timed out after 60s.")
        except Exception as exc:
            return ToolResult(success=False, output="", error=str(exc))

    def _detect(self, path: Path, filter: str) -> str:
        if (path / "pyproject.toml").exists() or (path / "pytest.ini").exists() or (path / "setup.py").exists():
            cmd = "python -m pytest -x --tb=short -q"
            if filter:
                cmd += f" -k {filter!r}"
            return cmd
        if (path / "package.json").exists():
            return "npm test --if-present"
        if (path / "Cargo.toml").exists():
            cmd = "cargo test"
            if filter:
                cmd += f" {filter}"
            return cmd
        return ""

    def estimate_data_cost(self, **_: Any) -> int:
        return 500

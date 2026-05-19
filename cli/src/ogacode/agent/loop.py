import json
import platform
from dataclasses import dataclass, field
from pathlib import Path

from ogacode.agent.events import (
    CORRECTION, ESCALATE, POST_TOOL, PRE_TOOL, PROVIDER, STOP, SUPERVISOR, THINKING,
    EventBus,
)
from ogacode.agent.supervisor import review as supervisor_review
from ogacode.providers.router import AllProvidersFailedError, call_llm
from ogacode.tools.bash_exec import BashExecTool
from ogacode.tools.base import Tool, ToolResult
from ogacode.tools.file_edit import FileEditTool
from ogacode.tools.ripgrep_search import RipgrepSearchTool
from ogacode.tools.test_runner import TestRunnerTool
from ogacode.tools.web_search import WebSearchTool

_OS = platform.system()
_SHELL_NOTE = (
    "Shell is PowerShell 5. Use semicolons (;) not && to chain commands. "
    "Use New-Item, Get-ChildItem, Remove-Item — not mkdir/ls/rm."
    if _OS == "Windows"
    else "Shell is bash."
)

_SYSTEM = f"""\
You are OgaCode, an agentic AI coding assistant.
OS: {_OS}. {_SHELL_NOTE}
Use tools to complete the user's task step by step.

Efficiency rules (CRITICAL — you have limited steps and context):
- List the project structure ONCE with bash_exec, then act immediately. Do not list again.
- Only READ a file immediately before editing it. Do not read files for "research".
- If a project already exists, read only the specific file you need to change, then change it.
- Batch multiple edits: read one file, edit it, move to the next. Do not read 5 files then edit.
- Never read CSS, JS, HTML files unless you are about to change them in the same step.

File editing rules:
- Always READ a file immediately before editing it (not earlier).
- To change an existing file: use file_edit action='edit' with old_string/new_string (targeted).
- To create a brand-new file: use file_edit action='create'.
- Never use action='create' on an existing file just to make a small change — use 'edit'.
- old_string must be unique in the file. Include enough surrounding lines to make it unique.
- Never create or read binary files (images, fonts, compiled files). Use CSS/SVG/base64 for graphics.
- Skip any image or binary file you encounter.

Fix tasks (when user says fix, debug, error, broken, not working):
- Read the file first. Understand the root cause before touching anything.
- Use 'edit' for targeted fixes — never rewrite the whole file for a one-line bug.
- After fixing, VERIFY: run the file with bash_exec, or run tests with test_runner.
- If the fix does not work, diagnose again and try a different approach.
- Never say DONE on a fix until you have confirmed it actually works.
- If you cannot fix after 3 attempts: HELP: <explain what you tried and what's still wrong>

When fully done: DONE: <one SHORT sentence — no markdown, no bullet points, no headers>
If you need user input: HELP: <question>
"""

_PLAN_SYSTEM = """\
You are a software architect. Given a task, output a JSON execution plan.
Reply with ONLY valid JSON — no markdown, no explanation:
{"steps": ["step 1", "step 2", ...], "summary": "one-line overview"}
"""


@dataclass
class AgentResult:
    success: bool
    summary: str
    error: str = ""
    steps_taken: int = 0
    files_written: list[str] = field(default_factory=list)


@dataclass
class Plan:
    steps: list[str]
    summary: str


def _make_tools(cwd: Path) -> list[Tool]:
    return [FileEditTool(cwd), BashExecTool(cwd), RipgrepSearchTool(cwd),
            TestRunnerTool(cwd), WebSearchTool()]


async def create_plan(task: str) -> Plan:
    """Ask the LLM to break the task into steps without executing anything."""
    resp = await call_llm([
        {"role": "system", "content": _PLAN_SYSTEM},
        {"role": "user", "content": f"Task: {task}"},
    ])
    raw = (resp["choices"][0]["message"].get("content") or "{}").strip()
    raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        data = json.loads(raw)
        return Plan(steps=data.get("steps", []), summary=data.get("summary", task))
    except json.JSONDecodeError:
        return Plan(steps=[task], summary=task)


async def agent_loop(
    task: str,
    cwd: Path,
    *,
    bus: EventBus | None = None,
    offline: bool = False,
    use_supervisor: bool = True,
    max_iterations: int = 35,
) -> AgentResult:
    """
    Plan -> Act -> Observe -> Correct loop.
    Escalates after 2 consecutive tool failures.
    Supervisor does a quality pass before returning DONE.
    All side-effects (logging, UI, permissions) are handled by listeners on the bus.
    """
    if bus is None:
        bus = EventBus()

    if offline:
        return AgentResult(success=False, summary="Offline mode: LLM unavailable.")

    tools = _make_tools(cwd)
    schemas = [t.to_openai_schema() for t in tools]
    tool_map = {t.name: t for t in tools}

    messages: list[dict] = [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": f"Task: {task}\nProject directory: {cwd}"},
    ]

    consecutive_failures = 0
    files_written: list[str] = []

    for i in range(max_iterations):
        bus.emit(THINKING, step=i + 1)

        try:
            response = await call_llm(
                messages, tools=schemas,
                on_provider=lambda p: bus.emit(PROVIDER, name=p),
            )
        except AllProvidersFailedError as exc:
            result = AgentResult(success=False, summary="All LLM providers failed.", error=str(exc))
            bus.emit(STOP, success=False, summary=result.summary, steps=i + 1, files=files_written)
            return result

        msg = response["choices"][0]["message"]
        messages.append(msg)

        if not msg.get("tool_calls"):
            content = (msg.get("content") or "").strip()

            if content.upper().startswith("DONE:"):
                summary = content[5:].strip()
                if use_supervisor and files_written:
                    bus.emit(SUPERVISOR, msg="Supervisor reviewing work...")
                    approved, issue = await supervisor_review(task, summary, files_written)
                    if not approved:
                        bus.emit(CORRECTION, msg=f"Supervisor: {issue} — fixing...")
                        messages.append({"role": "user", "content": f"Not quite done. Issue: {issue}. Please fix it."})
                        consecutive_failures = 0
                        continue
                bus.emit(STOP, success=True, summary=summary, steps=i + 1, files=files_written)
                return AgentResult(success=True, summary=summary,
                                   steps_taken=i + 1, files_written=files_written)

            if content.upper().startswith("HELP:"):
                ask = content[5:].strip()
                bus.emit(ESCALATE, msg=ask)
                bus.emit(STOP, success=False, summary=f"Needs your input: {ask}", steps=i + 1, files=files_written)
                return AgentResult(success=False, summary=f"Needs your input: {ask}",
                                   steps_taken=i + 1)

            bus.emit(STOP, success=True, summary=content[:200], steps=i + 1, files=files_written)
            return AgentResult(success=True, summary=content[:200],
                               steps_taken=i + 1, files_written=files_written)

        tool_results: list[dict] = []
        for tc in msg["tool_calls"]:
            fn_name = tc["function"]["name"]
            try:
                kwargs = json.loads(tc["function"].get("arguments", "{}"))
            except json.JSONDecodeError:
                kwargs = {}

            tool = tool_map.get(fn_name)
            if not tool:
                result_tr: ToolResult = ToolResult(success=False, output="", error=f"Unknown tool: {fn_name}")
            else:
                # Suppress large string args from the event log
                skip = {"content", "old_string", "new_string"}
                log_args = {k: v for k, v in kwargs.items() if k not in skip}
                if "old_string" in kwargs:
                    log_args["edit"] = f"{len(kwargs['old_string'])}→{len(kwargs.get('new_string',''))} chars"
                bus.emit(PRE_TOOL, tool=fn_name, args=log_args)
                result_tr = tool.execute(**kwargs)
                if fn_name == "file_edit" and result_tr.success and kwargs.get("action") in ("create", "edit"):
                    p = kwargs.get("path", "")
                    if p and p not in files_written:
                        files_written.append(p)

            bus.emit(POST_TOOL, tool=fn_name, success=result_tr.success,
                     output=result_tr.output[:500], error=result_tr.error)

            if result_tr.success:
                consecutive_failures = 0
            else:
                consecutive_failures += 1
                bus.emit(CORRECTION, msg=f"Tool failed ({result_tr.error}) — asking LLM to correct")
                if consecutive_failures >= 2:
                    failed = AgentResult(
                        success=False,
                        summary=f"Stuck after 2 failed attempts: {result_tr.error}",
                        error=result_tr.error,
                        steps_taken=i + 1,
                        files_written=files_written,
                    )
                    bus.emit(STOP, success=False, summary=failed.summary, steps=i + 1, files=files_written)
                    return failed

            tool_results.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": result_tr.output if result_tr.success else f"ERROR: {result_tr.error}",
            })

        messages.extend(tool_results)

    final = AgentResult(
        success=False,
        summary=f"Hit the {max_iterations}-step limit without completing.",
        steps_taken=max_iterations,
        files_written=files_written,
    )
    bus.emit(STOP, success=False, summary=final.summary, steps=max_iterations, files=files_written)
    return final

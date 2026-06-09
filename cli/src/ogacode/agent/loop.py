import json
import platform
from dataclasses import dataclass, field
from pathlib import Path

from ogacode.agent.events import (
    CORRECTION, ESCALATE, POST_TOOL, PRE_TOOL, PROVIDER, STOP, SUPERVISOR, THINKING,
    EventBus,
)
from ogacode.agent.supervisor import review as supervisor_review
from ogacode import memory as project_memory
from ogacode import rag as code_rag
from ogacode.providers.router import AllProvidersFailedError, call_llm
from ogacode.tools.bash_exec import BashExecTool
from ogacode.tools.base import Tool, ToolResult
from ogacode.tools.file_edit import FileEditTool
from ogacode.tools.ripgrep_search import RipgrepSearchTool
from ogacode.tools.test_runner import TestRunnerTool
from ogacode.tools.git_ops import GitOpsTool
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

Complex task decomposition (apply when the task involves 3 or more distinct components):
- Before writing any code, list every component: "COMPONENTS: [1. X, 2. Y, 3. Z]"
- Build ONE component at a time. Complete it (create → test → verify) before starting the next.
- State which component you are currently building at the start of each component.
- Do NOT wire components together until each one passes its own verification step.
- Example: "build a React app with auth and a dashboard" → auth API first, then UI, then wire.

Efficiency rules (CRITICAL — you have limited steps and context):
- List the project structure ONCE with bash_exec, then act immediately. Do not list again.
- Only READ a file immediately before editing it. Do not read files for "research".
- If a project already exists, read only the specific file you need to change, then change it.
- Batch multiple edits: read one file, edit it, move to the next. Do not read 5 files then edit.
- Never read CSS, JS, HTML files unless you are about to change them in the same step.
- Never run `pip install` or `pip install -e`. The package is already installed editably.
- On Windows, do NOT use `cd dir; command` — use full absolute paths in every command instead.
- For bulk transformations (remove all comments, rename a symbol everywhere, reformat a whole file): use a single bash_exec with a Python one-liner instead of many file_edit calls. Example: bash_exec(cmd='python -c "import re, pathlib; p=pathlib.Path(r\'file.py\'); p.write_text(re.sub(r\'#.*\', \'\', p.read_text()))"')

File editing rules:
- Always READ a file immediately before editing it (not earlier). Read each file ONCE — do not re-read.
- If a read result ends with "[N more chars — call read with offset=X]", call read again with that offset to get the rest. Do not use bash_exec to re-read the same file.
- To change an existing file: use file_edit action='edit' with old_string/new_string (targeted).
- To create a brand-new file: use file_edit action='create'.
- Never use action='create' on an existing file just to make a small change — use 'edit'.
- old_string must be unique in the file. Include enough surrounding lines to make it unique.
- Never create or read binary files (images, fonts, compiled files). Use CSS/SVG/base64 for graphics.
- Skip any image or binary file you encounter.
- NEVER call write_file(), open(), or any Python function inside bash_exec to write a file.
  To create a file use: file_edit action='create'. bash_exec is for shell commands only (python script.py, npm install, etc.).

Fix tasks (when user says fix, debug, error, broken, not working):
- Read the file first. Understand the root cause before touching anything.
- Use 'edit' for targeted fixes — never rewrite the whole file for a one-line bug.
- After fixing, VERIFY: run the file with bash_exec, or run tests with test_runner.
- If the fix does not work, diagnose again and try a different approach.
- Never say DONE on a fix until you have confirmed it actually works.
- If you cannot fix after 3 attempts: HELP: <explain what you tried and what's still wrong>

Verification rules (CRITICAL — never hallucinate success):
- Before running a verification command, state EXACTLY what output you expect.
- Use bash_exec with the `expect` param to enforce the check: bash_exec(cmd="...", expect="exact string").
- If output contains "error", "usage", "help", or is empty — the verification FAILED.
- "No crash" is not proof of success. Only exact expected output is proof.
- Never say DONE unless a verification command with `expect` confirmed the result.

When fully done: DONE: <one SHORT sentence — no markdown, no bullet points, no headers>
If you need user input: HELP: <question>
"""

_PLAN_SYSTEM = """\
You are a senior software architect. Given a coding task, output a structured execution plan as JSON.

The plan must have:
1. COMPONENTS — 2-5 independent building blocks (database, API, UI, tests, etc.)
2. STEPS — 5-12 sequential actions, one per file or function created or modified
3. Each step references its component, names exact files, and includes a runnable verification command

JSON format (reply with ONLY this, no markdown, no explanation):
{
  "summary": "one sentence describing the end result",
  "components": [
    {
      "name": "Component Name",
      "files": ["path/to/file.py"],
      "dependencies": ["Other Component"],
      "description": "what this component does"
    }
  ],
  "steps": [
    {
      "number": 1,
      "component": "Component Name",
      "action": "Create models.py with User and Transaction SQLAlchemy classes",
      "files": ["models.py"],
      "verification": "python -c 'from models import User; print(User.__tablename__)'"
    }
  ]
}

Rules:
- Steps are ordered: understand existing code -> create files -> wire together -> test
- Files must be specific (models.py, not 'the model file')
- Verification must be a runnable command (pytest, python -c, curl, npm test, etc.)
- Components build on each other — list their dependencies
"""


@dataclass
class AgentResult:
    success: bool
    summary: str
    error: str = ""
    steps_taken: int = 0
    files_written: list[str] = field(default_factory=list)


@dataclass
class PlanComponent:
    name: str
    files: list[str]
    dependencies: list[str]
    description: str


@dataclass
class PlanStepDetail:
    action: str
    files: list[str]
    verification: str


@dataclass
class Plan:
    steps: list[str]
    summary: str
    components: list[PlanComponent] = field(default_factory=list)
    step_details: list[PlanStepDetail] = field(default_factory=list)
    is_default: bool = False


def _make_tools(cwd: Path) -> list[Tool]:
    return [FileEditTool(cwd), BashExecTool(cwd), RipgrepSearchTool(cwd),
            TestRunnerTool(cwd), WebSearchTool(), GitOpsTool(cwd)]


def _get_default_plan(task: str) -> Plan:
    return Plan(
        steps=[
            "Read and understand the relevant files in the project",
            "Implement the requested changes step by step",
            "Test each change before moving to the next",
            "Verify the full result works correctly",
        ],
        summary=f"Complete: {task[:100]}",
        is_default=True,
    )


async def create_plan(task: str) -> Plan:
    """Ask the LLM to break the task into structured components and steps."""
    resp = await call_llm([
        {"role": "system", "content": _PLAN_SYSTEM},
        {"role": "user", "content": f"Task: {task}"},
    ])
    raw = (resp["choices"][0]["message"].get("content") or "{}").strip()
    raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        data = json.loads(raw)
        components = [
            PlanComponent(
                name=c.get("name", ""),
                files=c.get("files", []),
                dependencies=c.get("dependencies", []),
                description=c.get("description", ""),
            )
            for c in data.get("components", [])
        ]
        raw_steps = data.get("steps", [])
        step_details = [
            PlanStepDetail(
                action=s.get("action", str(s)) if isinstance(s, dict) else str(s),
                files=s.get("files", []) if isinstance(s, dict) else [],
                verification=s.get("verification", "") if isinstance(s, dict) else "",
            )
            for s in raw_steps
        ]
        steps = [sd.action for sd in step_details] or [task]
        return Plan(
            steps=steps,
            summary=data.get("summary", task),
            components=components,
            step_details=step_details,
        )
    except json.JSONDecodeError:
        return _get_default_plan(task)


async def create_plan_with_fallback(task: str) -> Plan:
    """Always returns a plan — falls back to generic steps if LLM call fails."""
    try:
        return await create_plan(task)
    except Exception:
        return _get_default_plan(task)


async def agent_loop(
    task: str,
    cwd: Path,
    *,
    bus: EventBus | None = None,
    offline: bool = False,
    use_supervisor: bool = True,
    max_iterations: int = 200,
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
        from ogacode.queue import enqueue
        task_id = enqueue(task, cwd)
        return AgentResult(
            success=False,
            summary=f"Queued offline (id={task_id}). Run [bold]ogacode flush[/] when back online.",
        )

    tools = _make_tools(cwd)
    schemas = [t.to_openai_schema() for t in tools]
    tool_map = {t.name: t for t in tools}

    mem_snippet = project_memory.get_context_snippet(cwd)

    # Optional RAG: inject top-5 relevant code chunks when Ollama is available.
    # The entire block is fire-and-forget — any failure leaves the agent unaffected.
    rag_context = ""
    try:
        if code_rag.is_available():
            code_rag.index_project(cwd)           # no-op if files unchanged
            snippets = code_rag.search(cwd, task)  # returns [] if index empty
            if snippets:
                rag_context = (
                    "=== RELEVANT CODE (semantic search over your project) ===\n"
                    + "\n---\n".join(snippets)
                    + "\n=== END ==="
                )
    except Exception:
        pass

    # System message stays static (rules, OS, tool schemas).
    # All dynamic per-task context goes in the user message so it's always seen fresh.
    # Order: RAG snippets → project memory → task (task last = strongest attention position).
    user_parts: list[str] = []
    if rag_context:
        user_parts.append(rag_context)
    if mem_snippet:
        user_parts.append(mem_snippet)
    user_parts.append(f"Task: {task}\nProject directory: {cwd}")

    messages: list[dict] = [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": "\n\n".join(user_parts)},
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
                summary = content[5:].strip().split("\n\n")[0].strip()
                if use_supervisor and files_written:
                    bus.emit(SUPERVISOR, msg="Supervisor reviewing work...")
                    approved, issue = await supervisor_review(task, summary, files_written)
                    if not approved:
                        bus.emit(CORRECTION, msg=f"Supervisor: {issue} — fixing...")
                        messages.append({"role": "user", "content": f"Not quite done. Issue: {issue}. Please fix it."})
                        consecutive_failures = 0
                        continue
                bus.emit(STOP, success=True, summary=summary, steps=i + 1, files=files_written)
                try:
                    project_memory.log_task(cwd, task, summary, files_written)
                except Exception:
                    pass  # memory write failure must never crash the agent
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
                err_preview = (result_tr.error or "no output")[:120]
                bus.emit(CORRECTION, msg=f"Tool failed ({err_preview}) — asking LLM to correct")
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

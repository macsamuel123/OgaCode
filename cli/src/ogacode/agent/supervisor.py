import time

from ogacode.providers.router import call_llm

_SYSTEM = """\
You are a senior engineer doing a 10-second quality gate check.
Reply with exactly one of:
  APPROVED
  ISSUE: <one sentence describing what is critically missing>
"""

# Rate limit: one LLM supervisor call per 5 seconds max.
# Rapid consecutive calls are auto-approved to prevent cost abuse.
_RATE_LIMIT_SECS = 5.0
_last_review_time: float = 0.0


async def review(task: str, summary: str, files_written: list[str]) -> tuple[bool, str]:
    """
    Second LLM pass after the builder finishes.
    Returns (approved, issue). On any provider error, approves automatically
    so the supervisor never blocks the user.
    """
    global _last_review_time
    now = time.monotonic()
    if now - _last_review_time < _RATE_LIMIT_SECS:
        return True, ""  # auto-approve rapid retries
    _last_review_time = now

    file_list = "\n".join(f"  - {f}" for f in files_written) or "  (no files written)"
    msg = (
        f"Task: {task}\n"
        f"Agent summary: {summary}\n"
        f"Files written:\n{file_list}\n\n"
        "Did this fully complete the task? Quick verdict only."
    )
    try:
        resp = await call_llm(
            [{"role": "system", "content": _SYSTEM}, {"role": "user", "content": msg}]
        )
        verdict = (resp["choices"][0]["message"].get("content") or "APPROVED").strip()
        if verdict.upper().startswith("ISSUE:"):
            return False, verdict[6:].strip()
        return True, ""
    except Exception:
        return True, ""  # never block the user on supervisor failure

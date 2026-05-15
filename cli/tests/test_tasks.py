"""
Progressive task tests for OgaCode — simple to full project.

Run all:        pytest tests/test_tasks.py -v
Run one tier:   pytest tests/test_tasks.py -v -k "tier1"
Skip slow:      pytest tests/test_tasks.py -v -m "not slow"

All tests hit a real LLM so they need API keys configured:
    ogacode setup
"""

import pytest
from pathlib import Path
from tests.conftest import run, tools_called, file_exists_with


# ── Tier 1: Single file, 1-2 LLM steps ───────────────────────────────────────

@pytest.mark.slow
@pytest.mark.asyncio
async def test_tier1_hello_function(tmp_path: Path):
    """Agent creates one file with a working function."""
    result, events = await run(
        "Create a file called greet.py with a Python function hello(name) "
        "that returns the string 'Hello, {name}!'",
        tmp_path,
    )

    assert result.success, f"Agent failed: {result.summary}"
    assert file_exists_with(tmp_path / "greet.py", "def hello", "return")


@pytest.mark.slow
@pytest.mark.asyncio
async def test_tier1_used_file_edit(tmp_path: Path):
    """Agent must use file_edit, not just talk about the task."""
    result, events = await run(
        "Create a file called greet.py with a Python function hello(name) "
        "that returns the string 'Hello, {name}!'",
        tmp_path,
    )

    assert "file_edit" in tools_called(events), \
        "Agent described the solution but never wrote a file"


# ── Tier 2: One file, multiple functions, 2-4 steps ──────────────────────────

@pytest.mark.slow
@pytest.mark.asyncio
async def test_tier2_calculator(tmp_path: Path):
    """Agent creates a module with four functions including edge-case handling."""
    result, events = await run(
        "Create calculator.py with four functions: add(a, b), subtract(a, b), "
        "multiply(a, b), divide(a, b). divide must raise ValueError when b is zero.",
        tmp_path,
    )

    assert result.success, f"Agent failed: {result.summary}"
    calc = tmp_path / "calculator.py"
    assert file_exists_with(calc, "def add", "def subtract", "def multiply", "def divide")
    assert file_exists_with(calc, "valueerror")


@pytest.mark.slow
@pytest.mark.asyncio
async def test_tier2_no_placeholders(tmp_path: Path):
    """Agent must write real logic, not placeholder comments."""
    result, events = await run(
        "Create calculator.py with four functions: add(a, b), subtract(a, b), "
        "multiply(a, b), divide(a, b). divide must raise ValueError when b is zero.",
        tmp_path,
    )

    text = (tmp_path / "calculator.py").read_text(encoding="utf-8")
    bad_phrases = ["# add logic here", "# todo", "pass  # implement", "add content here"]
    for phrase in bad_phrases:
        assert phrase.lower() not in text.lower(), \
            f"Agent wrote placeholder: '{phrase}'"


# ── Tier 3: One file, real logic with state, 3-6 steps ───────────────────────

@pytest.mark.slow
@pytest.mark.asyncio
async def test_tier3_password_checker(tmp_path: Path):
    """Agent builds a password strength checker with real scoring logic."""
    result, events = await run(
        "Create password_checker.py with a function check_strength(password) that returns "
        "'weak', 'medium', or 'strong'. Rules: weak = under 8 chars or no digits; "
        "strong = 12+ chars with uppercase, lowercase, digit, and special character; "
        "everything else is medium. Also add a main() that reads from input() and prints the result.",
        tmp_path,
    )

    assert result.success, f"Agent failed: {result.summary}"
    checker = tmp_path / "password_checker.py"
    assert file_exists_with(checker, "def check_strength", "weak", "medium", "strong")
    assert file_exists_with(checker, "def main")


@pytest.mark.slow
@pytest.mark.asyncio
async def test_tier3_number_guessing_game(tmp_path: Path):
    """Agent builds a complete interactive game with loop and hints."""
    result, events = await run(
        "Create guess.py — a number guessing game. The program picks a random integer "
        "between 1 and 100. The user guesses in a loop. After each wrong guess print "
        "'Too high' or 'Too low'. When correct, print the number of attempts taken. "
        "Limit to 10 attempts then reveal the answer.",
        tmp_path,
    )

    assert result.success, f"Agent failed: {result.summary}"
    game = tmp_path / "guess.py"
    assert file_exists_with(game, "import random", "too high", "too low")
    assert file_exists_with(game, "attempts")


# ── Tier 4: Two files, CLI with data persistence, 6-12 steps ─────────────────

@pytest.mark.slow
@pytest.mark.asyncio
async def test_tier4_budget_tracker(tmp_path: Path):
    """Agent builds a two-file budget tracker with CLI and JSON storage."""
    result, events = await run(
        "Build a budget tracker with two files:\n"
        "1. storage.py — functions load_data() and save_data(data) that read/write "
        "a list of transactions to budget.json. Each transaction has: type ('income' or "
        "'expense'), amount (float), description (str).\n"
        "2. budget.py — a click CLI with three commands:\n"
        "   - add-income AMOUNT DESCRIPTION\n"
        "   - add-expense AMOUNT DESCRIPTION\n"
        "   - balance  (prints total income, total expenses, and net balance)\n"
        "Both files must be complete and working Python.",
        tmp_path,
    )

    assert result.success, f"Agent failed: {result.summary}"
    assert file_exists_with(tmp_path / "storage.py", "def load_data", "def save_data", "json")
    # LLM writes def add_income (underscore); click exposes it as add-income (hyphen).
    # Check for the concepts, not the exact naming style.
    assert file_exists_with(tmp_path / "budget.py", "income", "expense", "balance")


@pytest.mark.slow
@pytest.mark.asyncio
async def test_tier4_multiple_files_written(tmp_path: Path):
    """Agent must create at least 2 files for the budget tracker."""
    result, events = await run(
        "Build a budget tracker with two files:\n"
        "1. storage.py — functions load_data() and save_data(data) that read/write "
        "a list of transactions to budget.json.\n"
        "2. budget.py — a click CLI with add-income, add-expense, and balance commands.",
        tmp_path,
    )

    py_files = list(tmp_path.glob("*.py"))
    assert len(py_files) >= 2, \
        f"Expected 2+ Python files, got: {[f.name for f in py_files]}"


# ── Tier 5: Full project — 3+ files, models, CLI, persistence ────────────────

@pytest.mark.slow
@pytest.mark.asyncio
async def test_tier5_grade_manager(tmp_path: Path):
    """Agent builds a complete 3-file student grade management system."""
    result, events = await run(
        "Build a student grade manager with three files:\n\n"
        "models.py:\n"
        "- Student dataclass with fields: name (str), grades (list[float])\n"
        "- A property 'average' that returns the mean of grades (0.0 if no grades)\n"
        "- A property 'status' that returns 'Pass' if average >= 50 else 'Fail'\n\n"
        "storage.py:\n"
        "- load_students() -> list[Student]: read from students.json, return [] if missing\n"
        "- save_students(students: list[Student]): write to students.json\n\n"
        "cli.py:\n"
        "- click CLI with four commands:\n"
        "  add-student NAME\n"
        "  add-grade NAME SCORE\n"
        "  list (shows all students with their average and Pass/Fail status)\n"
        "  report (shows class average and count of passing students)\n\n"
        "All three files must be complete Python with real logic, no placeholders.",
        tmp_path,
    )

    assert result.success, f"Agent failed: {result.summary}"

    # All three files must exist
    assert file_exists_with(tmp_path / "models.py", "dataclass", "average", "status")
    assert file_exists_with(tmp_path / "storage.py", "load_students", "save_students", "json")
    # Click auto-converts def add_student → add-student command; check concepts not exact syntax.
    assert file_exists_with(tmp_path / "cli.py", "student", "grade", "list", "report")


@pytest.mark.slow
@pytest.mark.asyncio
async def test_tier5_models_are_importable(tmp_path: Path):
    """The models.py the agent wrote must be syntactically valid Python."""
    import sys, importlib, ast

    result, events = await run(
        "Build a student grade manager with three files:\n\n"
        "models.py:\n"
        "- Student dataclass: name (str), grades (list[float])\n"
        "- property average: mean of grades, 0.0 if empty\n"
        "- property status: 'Pass' if average >= 50 else 'Fail'\n\n"
        "storage.py:\n"
        "- load_students() and save_students(students) using students.json\n\n"
        "cli.py:\n"
        "- click CLI: add-student NAME, add-grade NAME SCORE, list, report",
        tmp_path,
    )

    models_path = tmp_path / "models.py"
    assert models_path.exists(), "models.py was not created"
    source = models_path.read_text(encoding="utf-8")
    try:
        ast.parse(source)
    except SyntaxError as e:
        pytest.fail(f"models.py has a syntax error: {e}")


# ── Regression: agent loop events ────────────────────────────────────────────

@pytest.mark.slow
@pytest.mark.asyncio
async def test_event_bus_emits_expected_types(tmp_path: Path):
    """Every run must emit at least THINKING, PRE_TOOL, POST_TOOL, and STOP."""
    from ogacode.agent.events import THINKING, PRE_TOOL, POST_TOOL, STOP

    result, events = await run(
        "Create a file called hi.py containing: print('hi')",
        tmp_path,
    )

    types = {e["type"] for e in events}
    for expected in (THINKING, PRE_TOOL, POST_TOOL, STOP):
        assert expected in types, f"Event '{expected}' was never emitted"


@pytest.mark.slow
@pytest.mark.asyncio
async def test_stop_event_carries_result(tmp_path: Path):
    """The STOP event must include success, summary, steps, and files fields."""
    from ogacode.agent.events import STOP

    result, events = await run(
        "Create a file called hi.py containing: print('hi')",
        tmp_path,
    )

    stop_events = [e for e in events if e["type"] == STOP]
    assert stop_events, "No STOP event was emitted"
    stop = stop_events[-1]
    for field in ("success", "summary", "steps", "files"):
        assert field in stop, f"STOP event missing field '{field}'"

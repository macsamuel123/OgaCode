"""
Per-project SQLite memory.

Each project gets its own DB at ~/.ogacode/projects/<sha256(cwd)>.db
so switching directories always gives fresh context.

Schema:
  facts       — key/value pairs the agent learns and the user can set manually
  task_log    — compact record of every completed task (used for context injection)
"""

import hashlib
import json
import sqlite3
import time
from pathlib import Path
from typing import Any

_BASE = Path.home() / ".ogacode" / "projects"
_TASK_LOG_LIMIT = 20   # keep last N task summaries in context
_FACTS_LIMIT    = 50   # hard cap — oldest updated_at is dropped first


def _db_path(cwd: Path | str) -> Path:
    key = hashlib.sha256(str(cwd).encode()).hexdigest()
    return _BASE / f"{key}.db"


def _connect(cwd: Path | str) -> sqlite3.Connection:
    path = _db_path(cwd)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS facts (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            category   TEXT NOT NULL DEFAULT 'general',
            updated_at INTEGER NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS task_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            task       TEXT NOT NULL,
            summary    TEXT NOT NULL,
            files      TEXT NOT NULL DEFAULT '[]',
            logged_at  INTEGER NOT NULL
        )
    """)
    conn.commit()
    return conn


# ── Write ──────────────────────────────────────────────────────────────────────

def set_fact(cwd: Path | str, key: str, value: str, category: str = "general") -> None:
    """Store or update a single fact."""
    with _connect(cwd) as conn:
        conn.execute(
            "INSERT INTO facts (key, value, category, updated_at) VALUES (?, ?, ?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value,"
            " category=excluded.category, updated_at=excluded.updated_at",
            (key.lower().strip(), value.strip(), category, int(time.time())),
        )
        # Enforce cap — drop the oldest if over limit
        conn.execute(
            "DELETE FROM facts WHERE key IN ("
            "  SELECT key FROM facts ORDER BY updated_at ASC LIMIT MAX(0, (SELECT COUNT(*) FROM facts) - ?)"
            ")",
            (_FACTS_LIMIT,),
        )


def delete_fact(cwd: Path | str, key: str) -> bool:
    """Returns True if a fact was deleted."""
    with _connect(cwd) as conn:
        cur = conn.execute("DELETE FROM facts WHERE key=?", (key.lower().strip(),))
        return cur.rowcount > 0


def log_task(cwd: Path | str, task: str, summary: str, files: list[str]) -> None:
    """Record a completed task summary (used to inject recent history into the system prompt)."""
    with _connect(cwd) as conn:
        conn.execute(
            "INSERT INTO task_log (task, summary, files, logged_at) VALUES (?, ?, ?, ?)",
            (task[:500], summary[:500], json.dumps(files[:20]), int(time.time())),
        )
        # Keep only the most recent N entries
        conn.execute(
            "DELETE FROM task_log WHERE id NOT IN ("
            "  SELECT id FROM task_log ORDER BY logged_at DESC LIMIT ?"
            ")",
            (_TASK_LOG_LIMIT,),
        )


def clear(cwd: Path | str) -> None:
    """Wipe all memory for this project."""
    with _connect(cwd) as conn:
        conn.execute("DELETE FROM facts")
        conn.execute("DELETE FROM task_log")


# ── Read ───────────────────────────────────────────────────────────────────────

def get_facts(cwd: Path | str) -> list[dict[str, Any]]:
    with _connect(cwd) as conn:
        rows = conn.execute("SELECT key, value, category, updated_at FROM facts ORDER BY category, key").fetchall()
    return [dict(r) for r in rows]


def get_task_log(cwd: Path | str, limit: int = _TASK_LOG_LIMIT) -> list[dict[str, Any]]:
    with _connect(cwd) as conn:
        rows = conn.execute(
            "SELECT task, summary, files, logged_at FROM task_log ORDER BY logged_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_context_snippet(cwd: Path | str, max_chars: int = 2000) -> str:
    """
    Return a compact string to prepend to the agent system prompt.
    Stays under max_chars to protect the data budget.
    """
    facts = get_facts(cwd)
    recent = get_task_log(cwd, limit=5)

    if not facts and not recent:
        return ""

    parts: list[str] = ["=== PROJECT MEMORY ==="]

    if facts:
        parts.append("[Known facts]")
        for f in facts:
            parts.append(f"  {f['key']}: {f['value']}")

    if recent:
        parts.append("[Recent tasks]")
        for t in recent:
            files_str = ""
            try:
                files = json.loads(t["files"])
                if files:
                    files_str = f" (files: {', '.join(files[:3])})"
            except Exception:
                pass
            parts.append(f"  - {t['task'][:80]} → {t['summary'][:100]}{files_str}")

    parts.append("=== END ===")
    snippet = "\n".join(parts)
    return snippet[:max_chars]

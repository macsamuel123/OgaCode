import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_DB_PATH = Path.home() / ".ogacode" / "queue.db"


def _conn() -> sqlite3.Connection:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(_DB_PATH))
    con.row_factory = sqlite3.Row
    con.execute("""
        CREATE TABLE IF NOT EXISTS queued_tasks (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            task      TEXT NOT NULL,
            cwd       TEXT NOT NULL,
            queued_at TEXT NOT NULL,
            status    TEXT NOT NULL DEFAULT 'pending'
        )
    """)
    con.commit()
    return con


def enqueue(task: str, cwd: Path) -> int:
    with _conn() as con:
        cur = con.execute(
            "INSERT INTO queued_tasks (task, cwd, queued_at) VALUES (?, ?, ?)",
            (task, str(cwd), datetime.now(timezone.utc).isoformat()),
        )
        return cur.lastrowid  # type: ignore[return-value]


def list_pending() -> list[dict[str, Any]]:
    with _conn() as con:
        rows = con.execute(
            "SELECT id, task, cwd, queued_at FROM queued_tasks WHERE status = 'pending' ORDER BY id"
        ).fetchall()
    return [dict(r) for r in rows]


def mark_done(task_id: int, *, failed: bool = False) -> None:
    status = "failed" if failed else "done"
    with _conn() as con:
        con.execute("UPDATE queued_tasks SET status = ? WHERE id = ?", (status, task_id))


def pending_count() -> int:
    with _conn() as con:
        return con.execute(
            "SELECT COUNT(*) FROM queued_tasks WHERE status = 'pending'"
        ).fetchone()[0]

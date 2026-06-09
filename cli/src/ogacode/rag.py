"""
Optional code RAG using Ollama for embeddings.

Fully graceful degradation: if Ollama is not running, every public function
returns an empty result and the agent proceeds without RAG context.

Storage: two extra tables (rag_chunks, rag_file_mtimes) in the same per-project
SQLite DB managed by ogacode.memory — no new files, no new dependencies.

Embedding model: nomic-embed-text (274 MB, runs on CPU, works on 4GB RAM).
Similarity: pure-Python cosine — no numpy, no additional packages.
"""

import json
import math
import time
from pathlib import Path
from typing import Optional

import httpx

from ogacode.memory import _connect

_OLLAMA_BASE   = "http://localhost:11434"
_EMBED_MODEL   = "nomic-embed-text"
_CHUNK_LINES   = 50     # lines per chunk
_CHUNK_OVERLAP = 10     # overlap between consecutive chunks
_MAX_RESULTS   = 5      # snippets injected into each prompt
_MAX_FILE_KB   = 80     # skip files larger than this (binary-ish or generated)
_MAX_FILES     = 250    # index at most this many files per project

_SKIP_DIRS = frozenset({
    ".git", "node_modules", "__pycache__", ".venv", "venv",
    "dist", "build", ".next", "target", ".mypy_cache", ".pytest_cache",
    ".tox", "coverage", ".eggs",
})
_CODE_EXTS = frozenset({
    ".py", ".ts", ".tsx", ".js", ".jsx",
    ".html", ".css", ".sql", ".sh",
    ".md", ".json", ".toml", ".yaml", ".yml",
})


# ── Availability check ────────────────────────────────────────────────────────

def is_available() -> bool:
    """
    Returns True only when Ollama is running AND has nomic-embed-text loaded.
    Designed to fail fast (1 s timeout) so it never blocks the agent on a cold
    laptop where Ollama is absent.
    """
    try:
        r = httpx.get(f"{_OLLAMA_BASE}/api/tags", timeout=1.0)
        if r.status_code != 200:
            return False
        models = [m.get("name", "") for m in r.json().get("models", [])]
        return any(_EMBED_MODEL in m for m in models)
    except Exception:
        return False


# ── Internal helpers ──────────────────────────────────────────────────────────

def _embed(text: str) -> Optional[list[float]]:
    """Call Ollama embeddings endpoint. Returns None on any failure."""
    try:
        r = httpx.post(
            f"{_OLLAMA_BASE}/api/embeddings",
            json={"model": _EMBED_MODEL, "prompt": text},
            timeout=15.0,   # CPU inference on old hardware can be slow
        )
        if r.status_code == 200:
            return r.json().get("embedding")
    except Exception:
        pass
    return None


def _cosine(a: list[float], b: list[float]) -> float:
    dot   = sum(x * y for x, y in zip(a, b))
    mag_a = math.sqrt(sum(x * x for x in a))
    mag_b = math.sqrt(sum(x * x for x in b))
    return dot / (mag_a * mag_b + 1e-9)


def _ensure_tables(cwd: Path) -> None:
    with _connect(cwd) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS rag_chunks (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path   TEXT NOT NULL,
                chunk_idx   INTEGER NOT NULL,
                content     TEXT NOT NULL,
                embedding   BLOB NOT NULL,   -- JSON array stored as bytes
                indexed_at  INTEGER NOT NULL,
                UNIQUE(file_path, chunk_idx)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS rag_file_mtimes (
                file_path   TEXT PRIMARY KEY,
                mtime       REAL NOT NULL
            )
        """)


def _chunk_file(path: Path, cwd: Path) -> list[str]:
    """Split a source file into overlapping line-window chunks."""
    try:
        if path.stat().st_size > _MAX_FILE_KB * 1024:
            return []
        text = path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return []

    lines = text.splitlines()
    rel   = str(path.relative_to(cwd))
    chunks: list[str] = []
    i = 0
    while i < len(lines):
        window = lines[i : i + _CHUNK_LINES]
        header = f"# {rel}  lines {i + 1}–{i + len(window)}"
        chunks.append(header + "\n" + "\n".join(window))
        i += _CHUNK_LINES - _CHUNK_OVERLAP
    return chunks


def _iter_code_files(cwd: Path):
    count = 0
    for p in cwd.rglob("*"):
        if count >= _MAX_FILES:
            break
        if not p.is_file():
            continue
        if p.suffix not in _CODE_EXTS:
            continue
        if any(skip in p.parts for skip in _SKIP_DIRS):
            continue
        yield p
        count += 1


# ── Public API ────────────────────────────────────────────────────────────────

def index_project(cwd: Path | str) -> int:
    """
    Incrementally index changed source files into the per-project DB.
    Only re-embeds files whose mtime changed since the last run.
    Returns the number of newly indexed chunks.

    Safe to call at every agent task start — if nothing changed it's just
    a fast stat() loop with no embedding calls.
    """
    cwd = Path(cwd)
    _ensure_tables(cwd)
    indexed = 0
    now = int(time.time())

    with _connect(cwd) as conn:
        for path in _iter_code_files(cwd):
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            rel = str(path.relative_to(cwd))

            row = conn.execute(
                "SELECT mtime FROM rag_file_mtimes WHERE file_path=?", (rel,)
            ).fetchone()
            if row and abs(row["mtime"] - mtime) < 0.01:
                continue  # unchanged — skip embedding

            chunks = _chunk_file(path, cwd)
            if not chunks:
                continue

            conn.execute("DELETE FROM rag_chunks WHERE file_path=?", (rel,))
            for idx, chunk in enumerate(chunks):
                emb = _embed(chunk)
                if emb is None:
                    return indexed  # Ollama went away mid-run — stop cleanly
                conn.execute(
                    "INSERT OR REPLACE INTO rag_chunks"
                    " (file_path, chunk_idx, content, embedding, indexed_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (rel, idx, chunk[:3000], json.dumps(emb).encode(), now),
                )
                indexed += 1

            conn.execute(
                "INSERT OR REPLACE INTO rag_file_mtimes (file_path, mtime) VALUES (?, ?)",
                (rel, mtime),
            )

    return indexed


def search(cwd: Path | str, query: str, k: int = _MAX_RESULTS) -> list[str]:
    """
    Return the top-k code chunks most relevant to query.
    Returns [] silently if Ollama is unavailable or the index is empty.
    """
    cwd = Path(cwd)
    _ensure_tables(cwd)

    query_emb = _embed(query)
    if query_emb is None:
        return []

    with _connect(cwd) as conn:
        rows = conn.execute("SELECT content, embedding FROM rag_chunks").fetchall()

    if not rows:
        return []

    scored: list[tuple[float, str]] = []
    for row in rows:
        try:
            emb = json.loads(row["embedding"])
            scored.append((_cosine(query_emb, emb), row["content"]))
        except Exception:
            continue

    scored.sort(key=lambda x: x[0], reverse=True)
    return [content for _, content in scored[:k]]


def status(cwd: Path | str) -> dict:
    """Return index stats for the current project. Safe to call when Ollama is down."""
    cwd = Path(cwd)
    _ensure_tables(cwd)
    chunk_count = 0
    file_count  = 0
    last_ts     = None
    try:
        with _connect(cwd) as conn:
            chunk_count = conn.execute("SELECT COUNT(*) FROM rag_chunks").fetchone()[0]
            file_count  = conn.execute("SELECT COUNT(*) FROM rag_file_mtimes").fetchone()[0]
            row = conn.execute("SELECT MAX(indexed_at) FROM rag_chunks").fetchone()
            last_ts = row[0] if row else None
    except Exception:
        pass
    return {
        "ollama_available": is_available(),
        "embed_model":      _EMBED_MODEL,
        "embed_model_mb":   274,
        "files_indexed":    file_count,
        "chunks_indexed":   chunk_count,
        "last_indexed_at":  last_ts,   # epoch int or None
        "db_path":          str(_db_path(cwd)),
    }

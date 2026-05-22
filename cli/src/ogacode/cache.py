# SECURITY NOTE: Cache data is stored UNENCRYPTED on disk at ~/.ogacode/cache/.
# Do not cache sensitive completions on shared machines.
# Set OGACODE_NO_CACHE=1 to disable caching entirely for sensitive sessions.

import hashlib
import os
import re
from pathlib import Path
from typing import Any

import diskcache

_CACHE_DIR = Path.home() / ".ogacode" / "cache"
_STATS_KEY = "ogacode:stats:v1"

_CACHING_DISABLED = os.getenv("OGACODE_NO_CACHE", "").strip() not in ("", "0")

# 50MB cap — enough for months of responses on a constrained laptop
_cache = diskcache.Cache(str(_CACHE_DIR), size_limit=50 * 1024 * 1024)


def _normalize(prompt: str) -> str:
    """Lowercase + sort words so 'Fix LOGIN bug' == 'fix bug login'."""
    return " ".join(sorted(re.sub(r"\s+", " ", prompt.lower()).split()))


def cache_key(prompt: str) -> str:
    return hashlib.sha256(_normalize(prompt).encode()).hexdigest()[:16]


def get_cached(prompt: str) -> str | None:
    if _CACHING_DISABLED:
        return None
    hit = _cache.get(cache_key(prompt))
    if hit:
        _bump(cache_hit=True)
    return hit  # type: ignore[return-value]


def set_cached(prompt: str, response: str, *, tokens_sent: int = 0, bytes_used: int = 0) -> None:
    if _CACHING_DISABLED:
        return
    _cache.set(cache_key(prompt), response, expire=86400 * 7)  # 7-day TTL
    _bump(cache_hit=False, tokens_sent=tokens_sent, bytes_used=bytes_used)


def _bump(*, cache_hit: bool, tokens_sent: int = 0, bytes_used: int = 0) -> None:
    s: dict[str, int] = _cache.get(_STATS_KEY) or {"requests": 0, "cache_hits": 0, "tokens_sent": 0, "bytes_used": 0}
    s["requests"] += 1
    if cache_hit:
        s["cache_hits"] += 1
    s["tokens_sent"] += tokens_sent
    s["bytes_used"] += bytes_used
    _cache.set(_STATS_KEY, s)


def usage_stats(*, reset: bool = False) -> dict[str, Any]:
    s: dict[str, int] = _cache.get(_STATS_KEY) or {"requests": 0, "cache_hits": 0, "tokens_sent": 0, "bytes_used": 0}
    pct = (s["cache_hits"] / s["requests"] * 100) if s["requests"] > 0 else 0.0
    result = {**s, "cache_hit_pct": round(pct, 1)}
    if reset:
        _cache.set(_STATS_KEY, {"requests": 0, "cache_hits": 0, "tokens_sent": 0, "bytes_used": 0})
    return result

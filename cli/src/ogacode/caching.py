"""
Caching data layer — thread-safe, TTL-expiring, pattern-invalidating key-value store.

Provides:
  - get(key) / set(key, value, ttl)
  - invalidate(pattern) — wildcard (*) pattern matching
  - batch_get([keys]) / batch_set({key: value})
  - metrics: hits, misses, evictions, size
  - Thread-safe via threading.Lock
  - TTL-based automatic expiration

Usage:
    from ogacode.caching import Cache

    c = Cache()
    c.set("user:42", {"name": "Alice"}, ttl=60)
    val = c.get("user:42")
    c.invalidate("user:*")
    print(c.metrics())
"""

import fnmatch
import threading
import time
from typing import Any


class Cache:
    """Thread-safe in-memory cache with TTL, pattern invalidation, and metrics."""

    def __init__(self) -> None:
        self._store: dict[str, tuple[Any, float | None]] = {}  # key -> (value, expires_at)
        self._lock = threading.Lock()
        self._hits = 0
        self._misses = 0
        self._evictions = 0

    # ── core operations ──────────────────────────────────────────────

    def get(self, key: str) -> Any:
        """Retrieve a value by key. Returns None if missing or expired."""
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                self._misses += 1
                return None

            value, expires_at = entry
            if expires_at is not None and time.monotonic() > expires_at:
                del self._store[key]
                self._evictions += 1
                self._misses += 1
                return None

            self._hits += 1
            return value

    def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        """Store a value with optional TTL in seconds."""
        expires_at: float | None = None
        if ttl is not None:
            expires_at = time.monotonic() + ttl
        with self._lock:
            self._store[key] = (value, expires_at)

    def invalidate(self, pattern: str) -> int:
        """Remove all keys matching a wildcard pattern (e.g. 'user:*').

        Returns the number of keys removed.
        """
        removed = 0
        with self._lock:
            matching = [k for k in self._store if fnmatch.fnmatch(k, pattern)]
            for k in matching:
                del self._store[k]
                removed += 1
        return removed

    # ── batch operations ─────────────────────────────────────────────

    def batch_get(self, keys: list[str]) -> list[Any]:
        """Retrieve values for multiple keys. Missing/expired entries are None."""
        return [self.get(k) for k in keys]

    def batch_set(self, mapping: dict[str, Any], ttl: int | None = None) -> None:
        """Store multiple key-value pairs atomically with an optional TTL."""
        expires_at: float | None = None
        if ttl is not None:
            expires_at = time.monotonic() + ttl
        with self._lock:
            for key, value in mapping.items():
                self._store[key] = (value, expires_at)

    # ── maintenance ──────────────────────────────────────────────────

    def clear(self) -> None:
        """Remove all entries and reset metrics."""
        with self._lock:
            self._store.clear()
            self._hits = 0
            self._misses = 0
            self._evictions = 0

    def evict_expired(self) -> int:
        """Manually purge all expired entries. Returns count evicted."""
        now = time.monotonic()
        evicted = 0
        with self._lock:
            expired = [k for k, (_, exp) in self._store.items() if exp is not None and now > exp]
            for k in expired:
                del self._store[k]
                evicted += 1
            self._evictions += evicted
        return evicted

    # ── metrics ──────────────────────────────────────────────────────

    def metrics(self) -> dict[str, int]:
        """Return current cache statistics.

        Returns:
            dict with keys: hits, misses, evictions, size (number of entries)
        """
        with self._lock:
            return {
                "hits": self._hits,
                "misses": self._misses,
                "evictions": self._evictions,
                "size": len(self._store),
            }

    def __len__(self) -> int:
        """Return number of entries (including expired — use with caution)."""
        return len(self._store)

    def __contains__(self, key: str) -> bool:
        """Check if key exists and is not expired."""
        return self.get(key) is not None

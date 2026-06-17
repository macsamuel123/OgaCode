"""Credit system — manages user balances and transactions using a JSON file store."""

import json
import os
import threading
from datetime import datetime, timezone
from typing import Optional

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CREDITS_FILE = os.path.join(BASE_DIR, "..", "..", "credits.json")
TRANSACTIONS_FILE = os.path.join(BASE_DIR, "..", "..", "transactions.json")

_lock = threading.Lock()


def _load_json(path: str, default: list):
    """Load a JSON file, returning default if missing or corrupt."""
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data
    except (json.JSONDecodeError, FileNotFoundError):
        return default


def _save_json(path: str, data):
    """Atomically write JSON data to a file."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── User Credits ──────────────────────────────────────────────────────────────


def get_user_credits(user_id: str) -> int:
    """Get the current credit balance for a user."""
    with _lock:
        credits = _load_json(CREDITS_FILE, {})
        return credits.get(user_id, 0)


def add_credits(user_id: str, amount: int) -> int:
    """Add credits to a user's balance. Returns new balance."""
    with _lock:
        credits = _load_json(CREDITS_FILE, {})
        current = credits.get(user_id, 0)
        new_balance = current + amount
        credits[user_id] = new_balance
        _save_json(CREDITS_FILE, credits)
        return new_balance


def deduct_credits(user_id: str, amount: int) -> tuple[bool, int]:
    """Deduct credits from a user. Returns (success, new_balance)."""
    with _lock:
        credits = _load_json(CREDITS_FILE, {})
        current = credits.get(user_id, 0)
        if current < amount:
            return False, current
        new_balance = current - amount
        credits[user_id] = new_balance
        _save_json(CREDITS_FILE, credits)
        return True, new_balance


def set_credits(user_id: str, amount: int) -> int:
    """Set a user's credit balance directly. Returns new balance."""
    with _lock:
        credits = _load_json(CREDITS_FILE, {})
        credits[user_id] = amount
        _save_json(CREDITS_FILE, credits)
        return amount


# ── Transactions ──────────────────────────────────────────────────────────────


def record_transaction(
    user_id: str,
    transaction_type: str,
    amount: int,
    reference: str,
    metadata: Optional[dict] = None,
) -> dict:
    """Record a transaction (credit purchase, usage, refund, bonus)."""
    with _lock:
        txns = _load_json(TRANSACTIONS_FILE, [])
        txn = {
            "id": len(txns) + 1,
            "user_id": user_id,
            "type": transaction_type,
            "amount": amount,
            "reference": reference,
            "metadata": metadata or {},
            "created_at": _now_iso(),
        }
        txns.append(txn)
        _save_json(TRANSACTIONS_FILE, txns)
        return txn


def get_transactions(user_id: Optional[str] = None, limit: int = 50) -> list:
    """Get transactions, optionally filtered by user_id."""
    txns = _load_json(TRANSACTIONS_FILE, [])
    if user_id:
        txns = [t for t in txns if t["user_id"] == user_id]
    return txns[-limit:]


def get_transaction_by_reference(reference: str) -> Optional[dict]:
    """Look up a transaction by payment reference."""
    txns = _load_json(TRANSACTIONS_FILE, [])
    for t in txns:
        if t["reference"] == reference:
            return t
    return None

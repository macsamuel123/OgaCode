"""Payment API server — handles payment initiation, webhooks, and credit management."""

import json
import os
import re
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

from .config import settings
from .client import PaystackClient, PaystackError
from .credit_store import (
    get_user_credits,
    add_credits,
    deduct_credits,
    record_transaction,
    get_transactions,
    get_transaction_by_reference,
)


def _parse_path(path: str) -> tuple[str, dict]:
    """Parse a URL path and extract path parameters."""
    # /api/paystack/initialize
    if path == "/api/paystack/initialize":
        return "initialize", {}
    # /api/paystack/verify/<reference>
    m = re.match(r"^/api/paystack/verify/(.+)$", path)
    if m:
        return "verify", {"reference": m.group(1)}
    # /api/paystack/webhook
    if path == "/api/paystack/webhook":
        return "webhook", {}
    # /api/credits/<user_id>
    m = re.match(r"^/api/credits/([^/]+)$", path)
    if m:
        return "get_credits", {"user_id": m.group(1)}
    # /api/credits/<user_id>/deduct
    m = re.match(r"^/api/credits/([^/]+)/deduct$", path)
    if m:
        return "deduct_credits", {"user_id": m.group(1)}
    # /api/transactions
    if path == "/api/transactions":
        return "list_transactions", {}
    # /api/transactions/<reference>
    m = re.match(r"^/api/transactions/(.+)$", path)
    if m:
        return "get_transaction", {"reference": m.group(1)}
    return "unknown", {}


class PaymentHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the Paystack payment API."""

    paystack_client = PaystackClient()

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return b""
        return self.rfile.read(length)

    def do_POST(self):
        parsed = urlparse(self.path)
        route, params = _parse_path(parsed.path)

        if route == "initialize":
            self._handle_initialize()
        elif route == "webhook":
            self._handle_webhook()
        elif route == "deduct_credits":
            self._handle_deduct_credits(params["user_id"])
        else:
            self._send_json({"error": "Not Found"}, 404)

    def do_GET(self):
        parsed = urlparse(self.path)
        route, params = _parse_path(parsed.path)

        if route == "verify":
            self._handle_verify(params["reference"])
        elif route == "get_credits":
            self._handle_get_credits(params["user_id"])
        elif route == "list_transactions":
            self._handle_list_transactions()
        elif route == "get_transaction":
            self._handle_get_transaction(params["reference"])
        else:
            self._send_json({"error": "Not Found"}, 404)

    # ── Handlers ──────────────────────────────────────────────────────────

    def _handle_initialize(self):
        """POST /api/paystack/initialize — start a payment."""
        raw = self._read_body()
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json({"error": "Invalid JSON"}, 400)
            return

        email = str(data.get("email", "")).strip()
        amount_ngn = data.get("amount")

        if not email or "@" not in email:
            self._send_json({"error": "A valid email is required"}, 400)
            return

        try:
            amount_ngn = float(amount_ngn)
            if amount_ngn <= 0:
                raise ValueError
        except (ValueError, TypeError):
            self._send_json({"error": "Amount must be a positive number (in NGN)"}, 400)
            return

        amount_kobo = int(amount_ngn * 100)
        reference = str(uuid.uuid4()).replace("-", "")[:20]
        user_id = data.get("user_id", email)

        try:
            result = self.paystack_client.initialize_transaction(
                email=email,
                amount_kobo=amount_kobo,
                reference=reference,
                callback_url=data.get("callback_url", ""),
            )
        except PaystackError as e:
            self._send_json({"error": str(e)}, 502)
            return

        # Store pending transaction info
        record_transaction(
            user_id=user_id,
            transaction_type="pending",
            amount=int(amount_ngn * settings.CREDIT_PER_NGN),
            reference=reference,
            metadata={"email": email, "amount_ngn": amount_ngn},
        )

        self._send_json(
            {
                "authorization_url": result.get("authorization_url"),
                "reference": reference,
                "access_code": result.get("access_code", ""),
            },
            201,
        )

    def _handle_verify(self, reference: str):
        """GET /api/paystack/verify/<reference> — verify a payment."""
        try:
            result = self.paystack_client.verify_transaction(reference)
        except PaystackError as e:
            self._send_json({"error": str(e)}, 502)
            return

        status = result.get("status", "unknown")
        self._send_json({"reference": reference, "status": status, "data": result})

    def _handle_webhook(self):
        """POST /api/paystack/webhook — receive Paystack webhook events."""
        raw_body = self._read_body()
        signature = self.headers.get("x-paystack-signature", "")

        # Verify webhook signature
        if not self.paystack_client.verify_webhook_signature(raw_body, signature):
            self._send_json({"error": "Invalid signature"}, 401)
            return

        try:
            event = json.loads(raw_body)
        except json.JSONDecodeError:
            self._send_json({"error": "Invalid JSON"}, 400)
            return

        event_type = event.get("event", "")
        event_data = event.get("data", {})

        if event_type == "charge.success":
            reference = event_data.get("reference", "")
            status = event_data.get("status", "")
            amount_kobo = event_data.get("amount", 0)
            email = event_data.get("customer", {}).get("email", "")

            # Check if already processed
            existing = get_transaction_by_reference(reference)
            if existing and existing["type"] == "credit_purchase":
                self._send_json({"status": "already_processed"})
                return

            # Calculate credits
            amount_ngn = amount_kobo / 100
            credits = int(amount_ngn * settings.CREDIT_PER_NGN)

            # Add bonus on first transaction
            user_txns = [t for t in get_transactions() if t.get("metadata", {}).get("email") == email]
            if len(user_txns) <= 1:
                credits += settings.DEFAULT_CREDIT_BONUS

            user_id = event_data.get("user_id", email)
            new_balance = add_credits(user_id, credits)

            record_transaction(
                user_id=user_id,
                transaction_type="credit_purchase",
                amount=credits,
                reference=reference,
                metadata={
                    "email": email,
                    "amount_ngn": amount_ngn,
                    "paystack_status": status,
                    "bonus_included": credits > int(amount_ngn * settings.CREDIT_PER_NGN),
                },
            )

            self._send_json(
                {
                    "status": "success",
                    "user_id": user_id,
                    "credits_added": credits,
                    "new_balance": new_balance,
                }
            )
        else:
            # Acknowledge other events
            self._send_json({"status": "received", "event": event_type})

    def _handle_get_credits(self, user_id: str):
        """GET /api/credits/<user_id> — get user's credit balance."""
        balance = get_user_credits(user_id)
        self._send_json({"user_id": user_id, "credits": balance})

    def _handle_deduct_credits(self, user_id: str):
        """POST /api/credits/<user_id>/deduct — deduct credits from a user."""
        raw = self._read_body()
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json({"error": "Invalid JSON"}, 400)
            return

        amount = data.get("amount")
        try:
            amount = int(amount)
            if amount <= 0:
                raise ValueError
        except (ValueError, TypeError):
            self._send_json({"error": "Amount must be a positive integer"}, 400)
            return

        success, new_balance = deduct_credits(user_id, amount)
        if not success:
            self._send_json(
                {"error": "Insufficient credits", "user_id": user_id, "credits": new_balance},
                402,
            )
            return

        record_transaction(
            user_id=user_id,
            transaction_type="usage",
            amount=-amount,
            reference=data.get("reference", f"usage-{uuid.uuid4().hex[:12]}"),
            metadata={"reason": data.get("reason", "")},
        )

        self._send_json({"user_id": user_id, "credits_deducted": amount, "new_balance": new_balance})

    def _handle_list_transactions(self):
        """GET /api/transactions — list recent transactions."""
        txns = get_transactions()
        self._send_json({"transactions": txns})

    def _handle_get_transaction(self, reference: str):
        """GET /api/transactions/<reference> — get a specific transaction."""
        txn = get_transaction_by_reference(reference)
        if not txn:
            self._send_json({"error": "Transaction not found"}, 404)
            return
        self._send_json(txn)

    def log_message(self, format, *args):
        pass  # suppress logs


def run_server(host=None, port=None):
    """Start the Paystack payment API server."""
    host = host or settings.HOST
    port = port or settings.PORT
    server = HTTPServer((host, port), PaymentHandler)
    print(f"Paystack payment API running on http://{host}:{port}")
    print(f"Endpoints:")
    print(f"  POST /api/paystack/initialize     — Start a payment")
    print(f"  GET  /api/paystack/verify/<ref>    — Verify a payment")
    print(f"  POST /api/paystack/webhook         — Paystack webhook receiver")
    print(f"  GET  /api/credits/<user_id>        — Get credit balance")
    print(f"  POST /api/credits/<user_id>/deduct — Deduct credits")
    print(f"  GET  /api/transactions             — List transactions")
    print(f"  GET  /api/transactions/<ref>       — Get transaction by reference")
    server.serve_forever()


if __name__ == "__main__":
    run_server()

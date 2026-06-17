"""Tests for the Paystack payment API, credit system, and webhook handling."""

import io
import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import HTTPServer
from unittest.mock import patch
from urllib.parse import urlparse

import pytest

from src.paystack.config import settings
from src.paystack.client import PaystackClient, PaystackError
from src.paystack.credit_store import (
    get_user_credits,
    add_credits,
    deduct_credits,
    set_credits,
    record_transaction,
    get_transactions,
    get_transaction_by_reference,
)
from src.paystack.server import PaymentHandler, run_server


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def clean_credit_store():
    """Reset credit and transaction stores before each test."""
    # Remove test data files
    for f in ["credits.json", "transactions.json"]:
        path = os.path.join(os.path.dirname(os.path.dirname(__file__)), f)
        if os.path.exists(path):
            os.remove(path)
    yield


@pytest.fixture
def test_server():
    """Start a test server on a random port."""
    from http.server import HTTPServer

    port = 15501
    server = HTTPServer(("127.0.0.1", port), PaymentHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    time.sleep(0.1)
    yield port
    server.shutdown()


# ── Credit Store Tests ────────────────────────────────────────────────────────


class TestCreditStore:
    def test_get_credits_default_zero(self):
        assert get_user_credits("user_1") == 0

    def test_add_credits(self):
        balance = add_credits("user_1", 500)
        assert balance == 500
        assert get_user_credits("user_1") == 500

    def test_add_credits_multiple(self):
        add_credits("user_1", 200)
        add_credits("user_1", 300)
        assert get_user_credits("user_1") == 500

    def test_deduct_credits_success(self):
        add_credits("user_1", 1000)
        success, balance = deduct_credits("user_1", 300)
        assert success is True
        assert balance == 700

    def test_deduct_credits_insufficient(self):
        add_credits("user_1", 100)
        success, balance = deduct_credits("user_1", 200)
        assert success is False
        assert balance == 100  # unchanged

    def test_set_credits(self):
        set_credits("user_1", 999)
        assert get_user_credits("user_1") == 999

    def test_multiple_users_independent(self):
        add_credits("alice", 100)
        add_credits("bob", 200)
        assert get_user_credits("alice") == 100
        assert get_user_credits("bob") == 200


class TestTransactions:
    def test_record_transaction(self):
        txn = record_transaction("user_1", "credit_purchase", 5000, "ref_001")
        assert txn["user_id"] == "user_1"
        assert txn["type"] == "credit_purchase"
        assert txn["amount"] == 5000
        assert txn["reference"] == "ref_001"
        assert "created_at" in txn

    def test_get_transactions_by_user(self):
        record_transaction("user_1", "credit_purchase", 1000, "ref_a")
        record_transaction("user_2", "credit_purchase", 2000, "ref_b")
        record_transaction("user_1", "usage", -500, "ref_c")

        user1_txns = get_transactions(user_id="user_1")
        assert len(user1_txns) == 2
        assert all(t["user_id"] == "user_1" for t in user1_txns)

    def test_get_transaction_by_reference(self):
        record_transaction("user_1", "credit_purchase", 3000, "unique_ref_123")
        txn = get_transaction_by_reference("unique_ref_123")
        assert txn is not None
        assert txn["amount"] == 3000

    def test_get_transaction_by_reference_not_found(self):
        assert get_transaction_by_reference("nonexistent") is None


# ── Paystack Client Tests ─────────────────────────────────────────────────────


class TestPaystackClient:
    def test_client_initialization(self):
        client = PaystackClient(secret_key="sk_test_custom")
        assert client.secret_key == "sk_test_custom"
        assert client.base_url == "https://api.paystack.co"

    def test_client_uses_default_key(self):
        client = PaystackClient()
        assert client.secret_key == settings.PAYSTACK_SECRET_KEY

    def test_initialize_transaction_fails_with_test_key(self):
        """With a test key, Paystack should return an auth error."""
        err_body = json.dumps({"status": False, "message": "Invalid key"}).encode()
        mock_err = urllib.error.HTTPError(
            url="", code=401, msg="Unauthorized", hdrs={}, fp=io.BytesIO(err_body)
        )
        client = PaystackClient(secret_key="sk_test_invalid")
        with patch("urllib.request.urlopen", side_effect=mock_err):
            with pytest.raises(PaystackError):
                client.initialize_transaction(
                    email="test@example.com",
                    amount_kobo=50000,
                    reference="test_ref_fail",
                )

    def test_verify_transaction_fails_with_test_key(self):
        err_body = json.dumps({"status": False, "message": "Invalid key"}).encode()
        mock_err = urllib.error.HTTPError(
            url="", code=401, msg="Unauthorized", hdrs={}, fp=io.BytesIO(err_body)
        )
        client = PaystackClient(secret_key="sk_test_invalid")
        with patch("urllib.request.urlopen", side_effect=mock_err):
            with pytest.raises(PaystackError):
                client.verify_transaction("nonexistent_ref")

    def test_webhook_signature_verification_valid(self):
        """Test HMAC-SHA512 webhook signature verification."""
        client = PaystackClient()
        payload = b'{"event":"charge.success","data":{"reference":"ref_1"}}'
        # Generate a valid signature
        import hashlib
        import hmac

        secret = "test_webhook_secret"
        # Temporarily override the settings
        original_secret = settings.PAYSTACK_WEBHOOK_SECRET
        settings.PAYSTACK_WEBHOOK_SECRET = secret
        try:
            valid_sig = hmac.new(
                secret.encode("utf-8"), payload, hashlib.sha512
            ).hexdigest()
            assert client.verify_webhook_signature(payload, valid_sig) is True
        finally:
            settings.PAYSTACK_WEBHOOK_SECRET = original_secret

    def test_webhook_signature_verification_invalid(self):
        client = PaystackClient()
        payload = b'{"event":"charge.success"}'
        settings.PAYSTACK_WEBHOOK_SECRET = "test_secret"
        try:
            assert client.verify_webhook_signature(payload, "invalid_sig") is False
        finally:
            settings.PAYSTACK_WEBHOOK_SECRET = ""

    def test_webhook_signature_no_secret_skips(self):
        """If no webhook secret is configured, verification is skipped."""
        client = PaystackClient()
        settings.PAYSTACK_WEBHOOK_SECRET = ""
        assert client.verify_webhook_signature(b"{}", "") is True


# ── API Server Integration Tests ──────────────────────────────────────────────


class TestPaymentAPI:
    def test_initialize_payment_validation_no_email(self, test_server):
        """POST /api/paystack/initialize without email should return 400."""
        import urllib.request
        import urllib.error

        body = json.dumps({"amount": 500}).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{test_server}/api/paystack/initialize",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(req)
        assert exc.value.code == 400
        err = json.loads(exc.value.read().decode("utf-8"))
        assert "email" in err.get("error", "").lower()

    def test_initialize_payment_validation_no_amount(self, test_server):
        import urllib.request
        import urllib.error

        body = json.dumps({"email": "test@example.com"}).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{test_server}/api/paystack/initialize",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(req)
        assert exc.value.code == 400

    def test_initialize_payment_validation_invalid_amount(self, test_server):
        import urllib.request
        import urllib.error

        body = json.dumps({"email": "test@example.com", "amount": -100}).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{test_server}/api/paystack/initialize",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(req)
        assert exc.value.code == 400

    def test_initialize_payment_invalid_json(self, test_server):
        import urllib.request
        import urllib.error

        req = urllib.request.Request(
            f"http://127.0.0.1:{test_server}/api/paystack/initialize",
            data=b"not json",
            headers={"Content-Type": "application/json"},
        )
        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(req)
        assert exc.value.code == 400

    def test_get_credits_endpoint(self, test_server):
        """GET /api/credits/<user_id> should return balance."""
        import urllib.request

        # Set some credits first
        set_credits("test_user_api", 750)

        resp = urllib.request.urlopen(
            f"http://127.0.0.1:{test_server}/api/credits/test_user_api"
        )
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert data["user_id"] == "test_user_api"
        assert data["credits"] == 750

    def test_deduct_credits_success(self, test_server):
        """POST /api/credits/<user_id>/deduct should deduct credits."""
        import urllib.request

        set_credits("deduct_user", 1000)

        body = json.dumps({"amount": 300, "reason": "api_call"}).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{test_server}/api/credits/deduct_user/deduct",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp = urllib.request.urlopen(req)
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert data["credits_deducted"] == 300
        assert data["new_balance"] == 700

    def test_deduct_credits_insufficient(self, test_server):
        """POST with insufficient credits should return 402."""
        import urllib.request
        import urllib.error

        set_credits("poor_user", 50)

        body = json.dumps({"amount": 100}).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{test_server}/api/credits/poor_user/deduct",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(req)
        assert exc.value.code == 402
        err = json.loads(exc.value.read().decode("utf-8"))
        assert "insufficient" in err.get("error", "").lower()

    def test_list_transactions_endpoint(self, test_server):
        """GET /api/transactions should return list."""
        import urllib.request

        record_transaction("list_user", "credit_purchase", 2000, "list_ref_1")
        record_transaction("list_user", "usage", -500, "list_ref_2")

        resp = urllib.request.urlopen(
            f"http://127.0.0.1:{test_server}/api/transactions"
        )
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert "transactions" in data
        assert len(data["transactions"]) >= 2

    def test_get_transaction_by_reference_endpoint(self, test_server):
        """GET /api/transactions/<ref> should return the transaction."""
        import urllib.request

        record_transaction("ref_user", "credit_purchase", 5000, "find_me_ref")

        resp = urllib.request.urlopen(
            f"http://127.0.0.1:{test_server}/api/transactions/find_me_ref"
        )
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert data["reference"] == "find_me_ref"
        assert data["amount"] == 5000

    def test_get_transaction_not_found(self, test_server):
        """GET /api/transactions/<ref> for missing ref should return 404."""
        import urllib.request
        import urllib.error

        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(
                f"http://127.0.0.1:{test_server}/api/transactions/no_such_ref"
            )
        assert exc.value.code == 404

    def test_unknown_route_returns_404(self, test_server):
        import urllib.request
        import urllib.error

        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(
                f"http://127.0.0.1:{test_server}/api/paystack/nonexistent"
            )
        assert exc.value.code == 404

    def test_webhook_charge_success_credits_added(self, test_server):
        """POST /api/paystack/webhook with charge.success should add credits."""
        import urllib.request

        # Simulate a Paystack webhook event
        webhook_payload = {
            "event": "charge.success",
            "data": {
                "reference": "wh_ref_001",
                "status": "success",
                "amount": 50000,  # 500 NGN in kobo
                "customer": {"email": "webhook@test.com"},
                "user_id": "wh_user",
            },
        }

        body = json.dumps(webhook_payload).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{test_server}/api/paystack/webhook",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp = urllib.request.urlopen(req)
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert data["status"] == "success"
        assert data["user_id"] == "wh_user"
        # 500 NGN * 100 credits per NGN = 50000 credits + bonus on first
        assert data["credits_added"] >= 50000
        assert data["new_balance"] >= 50000

        # Verify credits were actually stored
        balance = get_user_credits("wh_user")
        assert balance == data["new_balance"]

    def test_webhook_duplicate_event_idempotent(self, test_server):
        """Processing the same webhook twice should not double-credit."""
        import urllib.request

        webhook_payload = {
            "event": "charge.success",
            "data": {
                "reference": "dup_ref_001",
                "status": "success",
                "amount": 20000,
                "customer": {"email": "dup@test.com"},
                "user_id": "dup_user",
            },
        }

        body = json.dumps(webhook_payload).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{test_server}/api/paystack/webhook",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        # First call
        resp1 = urllib.request.urlopen(req)
        data1 = json.loads(resp1.read().decode("utf-8"))
        balance_after_first = data1["new_balance"]

        # Second call (duplicate)
        resp2 = urllib.request.urlopen(req)
        data2 = json.loads(resp2.read().decode("utf-8"))
        assert data2["status"] == "already_processed"

        # Balance should not have changed
        assert get_user_credits("dup_user") == balance_after_first

    def test_webhook_other_event_acknowledged(self, test_server):
        """Non charge.success events should be acknowledged."""
        import urllib.request

        webhook_payload = {
            "event": "charge.verify",
            "data": {"reference": "other_ref"},
        }

        body = json.dumps(webhook_payload).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{test_server}/api/paystack/webhook",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp = urllib.request.urlopen(req)
        data = json.loads(resp.read().decode("utf-8"))
        assert data["status"] == "received"
        assert data["event"] == "charge.verify"

    def test_webhook_invalid_signature_rejected(self, test_server):
        """Webhook with invalid signature should be rejected."""
        import urllib.request
        import urllib.error

        settings.PAYSTACK_WEBHOOK_SECRET = "real_secret"
        try:
            webhook_payload = {"event": "charge.success", "data": {}}
            body = json.dumps(webhook_payload).encode("utf-8")
            req = urllib.request.Request(
                f"http://127.0.0.1:{test_server}/api/paystack/webhook",
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "x-paystack-signature": "bad_sig",
                },
                method="POST",
            )
            with pytest.raises(urllib.error.HTTPError) as exc:
                urllib.request.urlopen(req)
            assert exc.value.code == 401
        finally:
            settings.PAYSTACK_WEBHOOK_SECRET = ""

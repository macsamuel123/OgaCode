"""Paystack API client — handles payment initialization, verification, and webhooks."""

import hashlib
import hmac
import json
import urllib.request
import urllib.error
from typing import Optional

from .config import settings


class PaystackError(Exception):
    """Raised when the Paystack API returns an error."""


class PaystackClient:
    """Thin client for the Paystack REST API using only stdlib."""

    def __init__(self, secret_key: Optional[str] = None):
        self.secret_key = secret_key or settings.PAYSTACK_SECRET_KEY
        self.base_url = settings.PAYSTACK_API_BASE

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.secret_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        """Make an HTTP request to the Paystack API."""
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body else None

        req = urllib.request.Request(url, data=data, headers=self._headers(), method=method)
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw = resp.read().decode("utf-8")
                result = json.loads(raw)
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8")
            try:
                result = json.loads(raw)
            except json.JSONDecodeError:
                raise PaystackError(f"HTTP {e.code}: {raw}") from e
        except urllib.error.URLError as e:
            raise PaystackError(f"Connection error: {e.reason}") from e

        if not result.get("status"):
            msg = result.get("message", "Unknown Paystack error")
            raise PaystackError(msg)

        return result.get("data", {})

    def initialize_transaction(
        self, email: str, amount_kobo: int, reference: str, callback_url: str = ""
    ) -> dict:
        """Initialize a Paystack transaction.

        Args:
            email: Customer email.
            amount_kobo: Amount in kobo (1 NGN = 100 kobo).
            reference: Unique transaction reference.
            callback_url: URL to redirect after payment.

        Returns:
            Response data with authorization_url and reference.
        """
        body = {
            "email": email,
            "amount": amount_kobo,
            "reference": reference,
        }
        if callback_url:
            body["callback_url"] = callback_url

        return self._request("POST", "/transaction/initialize", body)

    def verify_transaction(self, reference: str) -> dict:
        """Verify a Paystack transaction status.

        Args:
            reference: The transaction reference to verify.

        Returns:
            Response data with status, amount, and customer info.
        """
        return self._request("GET", f"/transaction/verify/{urllib.parse.quote(reference, safe='')}")

    def verify_webhook_signature(self, payload_body: bytes, signature_header: str) -> bool:
        """Verify that a webhook request came from Paystack.

        Args:
            payload_body: Raw request body bytes.
            signature_header: Value of the 'x-paystack-signature' header.

        Returns:
            True if signature is valid.
        """
        secret = settings.PAYSTACK_WEBHOOK_SECRET
        if not secret:
            # If no secret configured, skip verification (test mode)
            return True

        expected = hmac.new(
            secret.encode("utf-8"),
            payload_body,
            hashlib.sha512,
        ).hexdigest()

        return hmac.compare_digest(expected, signature_header)

    def list_banks(self, country: str = "nigeria") -> list:
        """List available banks for a country."""
        return self._request("GET", f"/bank?country={country}")

    def resolve_account_number(self, account_number: str, bank_code: str) -> dict:
        """Resolve an account number to get the account name."""
        return self._request(
            "GET", f"/bank/resolve?account_number={account_number}&bank_code={bank_code}"
        )

"""Configuration for Paystack integration."""

import os


class Settings:
    """Application settings loaded from environment variables."""

    # Paystack API keys
    PAYSTACK_SECRET_KEY: str = os.getenv("PAYSTACK_SECRET_KEY", "sk_test_placeholder")
    PAYSTACK_PUBLIC_KEY: str = os.getenv("PAYSTACK_PUBLIC_KEY", "pk_test_placeholder")

    # Paystack API base URL
    PAYSTACK_API_BASE: str = "https://api.paystack.co"

    # Webhook secret (used to verify webhook signatures)
    PAYSTACK_WEBHOOK_SECRET: str = os.getenv("PAYSTACK_WEBHOOK_SECRET", "")

    # Server config
    HOST: str = os.getenv("HOST", "127.0.0.1")
    PORT: int = int(os.getenv("PORT", "5501"))

    # Credit system
    CREDIT_PER_NGN: int = 100  # 100 credits per 1 NGN
    DEFAULT_CREDIT_BONUS: int = 1000  # bonus credits on first payment


settings = Settings()

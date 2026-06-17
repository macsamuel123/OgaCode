"""Multi-provider notification system.

Supports email (SMTP) and Slack notifications with:
- Template rendering
- Message queuing with retry (exponential backoff, 3 retries)
- FastAPI REST API
- Webhook support
"""

from .models import (
    NotificationProvider,
    NotificationPriority,
    NotificationStatus,
    Notification,
    NotificationResult,
    Template,
)
from .providers import EmailProvider, SlackProvider, WebhookProvider
from .queue import NotificationQueue, RetryHandler
from .templates import TemplateEngine
from .api import create_app, NotificationAPI

__all__ = [
    "NotificationProvider",
    "NotificationPriority",
    "NotificationStatus",
    "Notification",
    "NotificationResult",
    "Template",
    "EmailProvider",
    "SlackProvider",
    "WebhookProvider",
    "NotificationQueue",
    "RetryHandler",
    "TemplateEngine",
    "create_app",
    "NotificationAPI",
]

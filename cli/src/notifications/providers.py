"""Notification providers: Email (SMTP), Slack, and Webhook."""

import json
import logging
import smtplib
import ssl
from abc import ABC, abstractmethod
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any, Optional
from urllib.request import Request, urlopen
from urllib.error import URLError

from .models import Notification, NotificationProvider, NotificationResult, NotificationStatus

logger = logging.getLogger(__name__)


class BaseProvider(ABC):
    """Abstract base class for notification providers."""

    @abstractmethod
    def send(self, notification: Notification) -> NotificationResult:
        """Send a notification. Returns a result."""
        ...

    @property
    @abstractmethod
    def provider_type(self) -> NotificationProvider:
        """The provider type this implements."""
        ...


class EmailProvider(BaseProvider):
    """Email notification provider using SMTP."""

    def __init__(
        self,
        smtp_host: str = "localhost",
        smtp_port: int = 1025,
        username: Optional[str] = None,
        password: Optional[str] = None,
        use_tls: bool = False,
        from_address: str = "noreply@example.com",
        from_name: str = "Notification System",
    ):
        self.smtp_host = smtp_host
        self.smtp_port = smtp_port
        self.username = username
        self.password = password
        self.use_tls = use_tls
        self.from_address = from_address
        self.from_name = from_name

    @property
    def provider_type(self) -> NotificationProvider:
        return NotificationProvider.EMAIL

    def send(self, notification: Notification) -> NotificationResult:
        """Send an email notification via SMTP."""
        try:
            msg = MIMEMultipart("alternative")
            msg["Subject"] = notification.subject
            msg["From"] = f"{self.from_name} <{self.from_address}>"
            msg["To"] = notification.recipient

            # Plain text version
            part1 = MIMEText(notification.body, "plain")
            msg.attach(part1)

            # HTML version (if body looks like HTML)
            if "<html" in notification.body or "<p>" in notification.body:
                part2 = MIMEText(notification.body, "html")
                msg.attach(part2)

            context = ssl.create_default_context() if self.use_tls else None

            with smtplib.SMTP(self.smtp_host, self.smtp_port, timeout=10) as server:
                if self.use_tls:
                    server.starttls(context=context)
                if self.username and self.password:
                    server.login(self.username, self.password)
                server.sendmail(self.from_address, [notification.recipient], msg.as_string())

            logger.info("Email sent to %s: %s", notification.recipient, notification.subject)
            return NotificationResult(
                success=True,
                notification_id=notification.id,
                provider=self.provider_type,
                status=NotificationStatus.SENT,
            )

        except (smtplib.SMTPException, OSError, TimeoutError) as e:
            error_msg = f"SMTP error: {e}"
            logger.error("Failed to send email to %s: %s", notification.recipient, error_msg)
            return NotificationResult(
                success=False,
                notification_id=notification.id,
                provider=self.provider_type,
                status=NotificationStatus.FAILED,
                error_message=error_msg,
            )


class SlackProvider(BaseProvider):
    """Slack notification provider using Incoming Webhooks."""

    def __init__(self, webhook_url: str = ""):
        self.webhook_url = webhook_url

    @property
    def provider_type(self) -> NotificationProvider:
        return NotificationProvider.SLACK

    def send(self, notification: Notification) -> NotificationResult:
        """Send a Slack notification via webhook."""
        try:
            payload = {
                "text": f"*{notification.subject}*\n{notification.body}",
                "mrkdwn": True,
            }

            if notification.metadata:
                if "channel" in notification.metadata:
                    payload["channel"] = notification.metadata["channel"]
                if "username" in notification.metadata:
                    payload["username"] = notification.metadata["username"]
                if "icon_emoji" in notification.metadata:
                    payload["icon_emoji"] = notification.metadata["icon_emoji"]

            data = json.dumps(payload).encode("utf-8")
            req = Request(
                self.webhook_url,
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )

            with urlopen(req, timeout=10) as response:
                response_body = response.read().decode("utf-8")
                if response.status != 200:
                    raise URLError(f"Slack API returned status {response.status}: {response_body}")

            logger.info("Slack notification sent to %s", notification.recipient)
            return NotificationResult(
                success=True,
                notification_id=notification.id,
                provider=self.provider_type,
                status=NotificationStatus.SENT,
            )

        except (URLError, OSError, json.JSONDecodeError) as e:
            error_msg = f"Slack error: {e}"
            logger.error("Failed to send Slack notification: %s", error_msg)
            return NotificationResult(
                success=False,
                notification_id=notification.id,
                provider=self.provider_type,
                status=NotificationStatus.FAILED,
                error_message=error_msg,
            )


class WebhookProvider(BaseProvider):
    """Generic webhook notification provider."""

    def __init__(self, webhook_url: str = ""):
        self.webhook_url = webhook_url

    @property
    def provider_type(self) -> NotificationProvider:
        return NotificationProvider.WEBHOOK

    def send(self, notification: Notification) -> NotificationResult:
        """Send a notification via generic webhook."""
        try:
            payload = {
                "event": "notification",
                "id": notification.id,
                "provider": notification.provider.value,
                "recipient": notification.recipient,
                "subject": notification.subject,
                "body": notification.body,
                "priority": notification.priority.value,
                "metadata": notification.metadata,
                "timestamp": notification.created_at.isoformat(),
            }

            data = json.dumps(payload).encode("utf-8")
            req = Request(
                self.webhook_url,
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )

            with urlopen(req, timeout=10) as response:
                response_body = response.read().decode("utf-8")
                if response.status not in (200, 201, 202, 204):
                    raise URLError(f"Webhook returned status {response.status}: {response_body}")

            logger.info("Webhook notification sent to %s", notification.recipient)
            return NotificationResult(
                success=True,
                notification_id=notification.id,
                provider=self.provider_type,
                status=NotificationStatus.SENT,
            )

        except (URLError, OSError, json.JSONDecodeError) as e:
            error_msg = f"Webhook error: {e}"
            logger.error("Failed to send webhook notification: %s", error_msg)
            return NotificationResult(
                success=False,
                notification_id=notification.id,
                provider=self.provider_type,
                status=NotificationStatus.FAILED,
                error_message=error_msg,
            )

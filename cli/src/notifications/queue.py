"""Message queue for notifications with exponential backoff retry logic."""

import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .models import (
    Notification,
    NotificationPriority,
    NotificationProvider,
    NotificationResult,
    NotificationStatus,
)
from .providers import BaseProvider, EmailProvider, SlackProvider, WebhookProvider

logger = logging.getLogger(__name__)


class RetryHandler:
    """Handles retry logic with exponential backoff.

    Backoff formula: base_delay * (2 ^ attempt) + jitter
    Max 3 retries by default.
    """

    def __init__(self, max_retries: int = 3, base_delay: float = 1.0, max_delay: float = 60.0):
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.max_delay = max_delay

    def get_delay(self, attempt: int) -> float:
        """Calculate delay for a given attempt number (0-indexed)."""
        delay = min(self.base_delay * (2 ** attempt), self.max_delay)
        # Add jitter: ±25%
        import random
        jitter = delay * random.uniform(-0.25, 0.25)
        return max(0.1, delay + jitter)

    def should_retry(self, notification: Notification) -> bool:
        """Check if a notification should be retried."""
        return (
            notification.status in (NotificationStatus.FAILED, NotificationStatus.RETRYING)
            and notification.retry_count < self.max_retries
        )

    def calculate_next_retry(self, notification: Notification) -> float:
        """Calculate the next retry delay in seconds."""
        return self.get_delay(notification.retry_count)


class NotificationQueue:
    """Queue for managing notification delivery with retry support.

    Stores pending and failed notifications in memory with optional
    persistence to disk.
    """

    def __init__(
        self,
        retry_handler: Optional[RetryHandler] = None,
        persist_path: Optional[str] = None,
    ):
        self.retry_handler = retry_handler or RetryHandler()
        self._queue: list[Notification] = []
        self._failed: list[Notification] = []
        self._sent: list[Notification] = []
        self._lock = threading.Lock()
        self._persist_path = persist_path
        self._providers: dict[NotificationProvider, BaseProvider] = {}

        if self._persist_path:
            self._load_persisted()

    def register_provider(self, provider: BaseProvider) -> None:
        """Register a provider for sending notifications."""
        self._providers[provider.provider_type] = provider

    def register_providers(self, providers: list[BaseProvider]) -> None:
        """Register multiple providers."""
        for p in providers:
            self.register_provider(p)

    def enqueue(self, notification: Notification) -> None:
        """Add a notification to the queue."""
        with self._lock:
            notification.status = NotificationStatus.PENDING
            notification.updated_at = datetime.now(timezone.utc)
            self._queue.append(notification)
            self._persist()

    def enqueue_many(self, notifications: list[Notification]) -> None:
        """Add multiple notifications to the queue."""
        with self._lock:
            for n in notifications:
                n.status = NotificationStatus.PENDING
                n.updated_at = datetime.now(timezone.utc)
                self._queue.append(n)
            self._persist()

    def dequeue(self) -> Optional[Notification]:
        """Get the next pending notification (highest priority first)."""
        with self._lock:
            if not self._queue:
                return None

            # Sort by priority: critical > high > medium > low
            priority_order = {
                NotificationPriority.CRITICAL: 0,
                NotificationPriority.HIGH: 1,
                NotificationPriority.MEDIUM: 2,
                NotificationPriority.LOW: 3,
            }
            self._queue.sort(key=lambda n: (priority_order.get(n.priority, 99), n.created_at))
            return self._queue.pop(0)

    def process_next(self) -> Optional[NotificationResult]:
        """Process the next notification in the queue."""
        notification = self.dequeue()
        if notification is None:
            return None
        return self._send_notification(notification)

    def process_all(self) -> list[NotificationResult]:
        """Process all pending notifications."""
        results: list[NotificationResult] = []
        while True:
            result = self.process_next()
            if result is None:
                break
            results.append(result)
        return results

    def _send_notification(self, notification: Notification) -> NotificationResult:
        """Send a notification using the appropriate provider."""
        provider = self._providers.get(notification.provider)
        if provider is None:
            result = NotificationResult(
                success=False,
                notification_id=notification.id,
                provider=notification.provider,
                status=NotificationStatus.FAILED,
                error_message=f"No provider registered for {notification.provider.value}",
            )
            self._handle_failure(notification, result)
            return result

        result = provider.send(notification)

        with self._lock:
            if result.success:
                notification.status = NotificationStatus.SENT
                notification.updated_at = datetime.now(timezone.utc)
                self._sent.append(notification)
            else:
                notification.error_message = result.error_message
                self._handle_failure(notification, result)

            self._persist()

        return result

    def _handle_failure(self, notification: Notification, result: NotificationResult) -> None:
        """Handle a failed notification with retry logic."""
        if self.retry_handler.should_retry(notification):
            notification.retry_count += 1
            notification.status = NotificationStatus.RETRYING
            notification.updated_at = datetime.now(timezone.utc)
            delay = self.retry_handler.calculate_next_retry(notification)
            notification.metadata["next_retry_delay"] = delay
            notification.metadata["next_retry_at"] = (
                datetime.now(timezone.utc).timestamp() + delay
            )
            self._queue.append(notification)
            logger.info(
                "Notification %s will retry in %.2fs (attempt %d/%d)",
                notification.id,
                delay,
                notification.retry_count,
                notification.max_retries,
            )
        else:
            notification.status = NotificationStatus.FAILED
            notification.updated_at = datetime.now(timezone.utc)
            self._failed.append(notification)
            logger.warning(
                "Notification %s failed after %d retries: %s",
                notification.id,
                notification.retry_count,
                result.error_message,
            )

    def retry_failed(self) -> list[NotificationResult]:
        """Retry all failed notifications that haven't exceeded max retries."""
        results: list[NotificationResult] = []
        with self._lock:
            still_failed: list[Notification] = []
            for notification in self._failed:
                if self.retry_handler.should_retry(notification):
                    notification.status = NotificationStatus.RETRYING
                    self._queue.append(notification)
                else:
                    still_failed.append(notification)
            self._failed = still_failed

        # Process the requeued notifications
        results = self.process_all()
        return results

    def get_queue_length(self) -> int:
        """Get the number of pending notifications."""
        with self._lock:
            return len(self._queue)

    def get_failed_count(self) -> int:
        """Get the number of failed notifications."""
        with self._lock:
            return len(self._failed)

    def get_sent_count(self) -> int:
        """Get the number of sent notifications."""
        with self._lock:
            return len(self._sent)

    def list_pending(self) -> list[Notification]:
        """List all pending notifications."""
        with self._lock:
            return list(self._queue)

    def list_failed(self) -> list[Notification]:
        """List all failed notifications."""
        with self._lock:
            return list(self._failed)

    def list_sent(self) -> list[Notification]:
        """List all sent notifications."""
        with self._lock:
            return list(self._sent)

    def get_by_id(self, notification_id: str) -> Optional[Notification]:
        """Find a notification by ID across all queues."""
        with self._lock:
            for n in self._queue:
                if n.id == notification_id:
                    return n
            for n in self._failed:
                if n.id == notification_id:
                    return n
            for n in self._sent:
                if n.id == notification_id:
                    return n
        return None

    def cancel(self, notification_id: str) -> bool:
        """Cancel a pending notification."""
        with self._lock:
            for i, n in enumerate(self._queue):
                if n.id == notification_id:
                    n.status = NotificationStatus.CANCELLED
                    n.updated_at = datetime.now(timezone.utc)
                    self._queue.pop(i)
                    self._persist()
                    return True
        return False

    def clear(self) -> None:
        """Clear all queues."""
        with self._lock:
            self._queue.clear()
            self._failed.clear()
            self._sent.clear()
            self._persist()

    def _persist(self) -> None:
        """Persist queue state to disk."""
        if not self._persist_path:
            return
        try:
            data = {
                "queue": [n.to_dict() for n in self._queue],
                "failed": [n.to_dict() for n in self._failed],
                "sent": [n.to_dict() for n in self._sent],
            }
            path = Path(self._persist_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(data, indent=2, default=str))
        except OSError as e:
            logger.warning("Failed to persist queue: %s", e)

    def _load_persisted(self) -> None:
        """Load queue state from disk."""
        if not self._persist_path:
            return
        path = Path(self._persist_path)
        if not path.exists():
            return
        try:
            data = json.loads(path.read_text())
            with self._lock:
                self._queue = [Notification.from_dict(n) for n in data.get("queue", [])]
                self._failed = [Notification.from_dict(n) for n in data.get("failed", [])]
                self._sent = [Notification.from_dict(n) for n in data.get("sent", [])]
        except (OSError, json.JSONDecodeError, KeyError) as e:
            logger.warning("Failed to load persisted queue: %s", e)

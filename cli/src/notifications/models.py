"""Data models for the notification system."""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional


class NotificationProvider(str, Enum):
    """Supported notification providers."""
    EMAIL = "email"
    SLACK = "slack"
    WEBHOOK = "webhook"


class NotificationPriority(str, Enum):
    """Notification priority levels."""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class NotificationStatus(str, Enum):
    """Status of a notification."""
    PENDING = "pending"
    SENT = "sent"
    FAILED = "failed"
    RETRYING = "retrying"
    CANCELLED = "cancelled"


@dataclass
class Template:
    """A notification template."""
    name: str
    subject_template: str
    body_template: str
    provider: NotificationProvider = NotificationProvider.EMAIL
    variables: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "subject_template": self.subject_template,
            "body_template": self.body_template,
            "provider": self.provider.value,
            "variables": self.variables,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Template":
        return cls(
            name=data["name"],
            subject_template=data["subject_template"],
            body_template=data["body_template"],
            provider=NotificationProvider(data.get("provider", "email")),
            variables=data.get("variables", {}),
        )


@dataclass
class Notification:
    """A notification to be sent."""
    id: str
    provider: NotificationProvider
    recipient: str
    subject: str
    body: str
    priority: NotificationPriority = NotificationPriority.MEDIUM
    status: NotificationStatus = NotificationStatus.PENDING
    template_name: Optional[str] = None
    template_vars: dict[str, str] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    retry_count: int = 0
    max_retries: int = 3
    error_message: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "provider": self.provider.value,
            "recipient": self.recipient,
            "subject": self.subject,
            "body": self.body,
            "priority": self.priority.value,
            "status": self.status.value,
            "template_name": self.template_name,
            "template_vars": self.template_vars,
            "metadata": self.metadata,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "retry_count": self.retry_count,
            "max_retries": self.max_retries,
            "error_message": self.error_message,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Notification":
        return cls(
            id=data["id"],
            provider=NotificationProvider(data["provider"]),
            recipient=data["recipient"],
            subject=data["subject"],
            body=data["body"],
            priority=NotificationPriority(data.get("priority", "medium")),
            status=NotificationStatus(data.get("status", "pending")),
            template_name=data.get("template_name"),
            template_vars=data.get("template_vars", {}),
            metadata=data.get("metadata", {}),
            created_at=datetime.fromisoformat(data["created_at"]) if "created_at" in data else datetime.now(timezone.utc),
            updated_at=datetime.fromisoformat(data["updated_at"]) if "updated_at" in data else datetime.now(timezone.utc),
            retry_count=data.get("retry_count", 0),
            max_retries=data.get("max_retries", 3),
            error_message=data.get("error_message"),
        )


@dataclass
class NotificationResult:
    """Result of sending a notification."""
    success: bool
    notification_id: str
    provider: NotificationProvider
    status: NotificationStatus
    error_message: Optional[str] = None
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        return {
            "success": self.success,
            "notification_id": self.notification_id,
            "provider": self.provider.value,
            "status": self.status.value,
            "error_message": self.error_message,
            "timestamp": self.timestamp.isoformat(),
        }

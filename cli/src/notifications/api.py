"""FastAPI REST API for the notification system."""

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .models import (
    Notification,
    NotificationPriority,
    NotificationProvider,
    NotificationStatus,
    Template,
)
from .providers import EmailProvider, SlackProvider, WebhookProvider
from .queue import NotificationQueue, RetryHandler
from .templates import TemplateEngine


# ── Pydantic request/response models ──────────────────────────────────

class SendNotificationRequest(BaseModel):
    provider: str = Field(..., description="Provider: email, slack, or webhook")
    recipient: str = Field(..., description="Recipient address/channel")
    subject: str = Field(..., description="Notification subject")
    body: str = Field(..., description="Notification body")
    priority: str = Field("medium", description="Priority: low, medium, high, critical")
    template_name: Optional[str] = Field(None, description="Optional template name")
    template_vars: dict[str, str] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


class SendTemplateRequest(BaseModel):
    template_name: str = Field(..., description="Name of the template to use")
    recipient: str = Field(..., description="Recipient address/channel")
    variables: dict[str, str] = Field(default_factory=dict, description="Template variables")
    priority: str = Field("medium")
    provider: Optional[str] = Field(None, description="Override provider")
    metadata: dict[str, Any] = Field(default_factory=dict)


class NotificationResponse(BaseModel):
    id: str
    provider: str
    recipient: str
    subject: str
    body: str
    priority: str
    status: str
    template_name: Optional[str] = None
    template_vars: dict[str, str] = {}
    metadata: dict[str, Any] = {}
    created_at: str
    updated_at: str
    retry_count: int = 0
    max_retries: int = 3
    error_message: Optional[str] = None


class QueueStatusResponse(BaseModel):
    pending: int
    failed: int
    sent: int


class TemplateCreateRequest(BaseModel):
    name: str
    subject_template: str
    body_template: str
    provider: str = "email"
    variables: dict[str, str] = Field(default_factory=dict)


class TemplateResponse(BaseModel):
    name: str
    subject_template: str
    body_template: str
    provider: str
    variables: dict[str, str]


class RetryResponse(BaseModel):
    retried: int
    results: list[dict[str, Any]]


class WebhookPayload(BaseModel):
    event: str = Field(..., description="Event type")
    payload: dict[str, Any] = Field(default_factory=dict, description="Event payload")


# ── FastAPI App Factory ───────────────────────────────────────────────

class NotificationAPI:
    """Factory for creating the FastAPI notification app."""

    def __init__(
        self,
        queue: Optional[NotificationQueue] = None,
        template_engine: Optional[TemplateEngine] = None,
        email_config: Optional[dict[str, Any]] = None,
        slack_webhook_url: Optional[str] = None,
        webhook_url: Optional[str] = None,
    ):
        self.queue = queue or NotificationQueue()
        self.template_engine = template_engine or TemplateEngine()

        # Register default providers
        if email_config:
            self.queue.register_provider(EmailProvider(**email_config))
        if slack_webhook_url:
            self.queue.register_provider(SlackProvider(webhook_url=slack_webhook_url))
        if webhook_url:
            self.queue.register_provider(WebhookProvider(webhook_url=webhook_url))

        self.app = self._create_app()

    def _create_app(self) -> FastAPI:
        app = FastAPI(
            title="Notification System API",
            description="Multi-provider notification system with email, Slack, and webhook support",
            version="1.0.0",
        )

        # ── Health ────────────────────────────────────────────────────

        @app.get("/health")
        async def health():
            return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}

        # ── Send Notification ─────────────────────────────────────────

        @app.post("/notifications/send", response_model=NotificationResponse)
        async def send_notification(req: SendNotificationRequest):
            try:
                provider = NotificationProvider(req.provider)
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Invalid provider: {req.provider}")

            try:
                priority = NotificationPriority(req.priority)
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Invalid priority: {req.priority}")

            notification = Notification(
                id=str(uuid.uuid4()),
                provider=provider,
                recipient=req.recipient,
                subject=req.subject,
                body=req.body,
                priority=priority,
                template_name=req.template_name,
                template_vars=req.template_vars,
                metadata=req.metadata,
            )

            self.queue.enqueue(notification)
            result = self.queue.process_next()

            if result and result.success:
                return _notification_to_response(notification)

            # If it failed but will retry, return retrying status
            if notification.status == NotificationStatus.RETRYING:
                return _notification_to_response(notification)

            # If it failed permanently
            raise HTTPException(
                status_code=502,
                detail={
                    "message": "Failed to send notification",
                    "error": notification.error_message,
                    "notification_id": notification.id,
                },
            )

        # ── Send via Template ─────────────────────────────────────────

        @app.post("/notifications/send-template", response_model=NotificationResponse)
        async def send_template(req: SendTemplateRequest):
            try:
                subject, body = self.template_engine.render(
                    req.template_name,
                    req.variables,
                )
            except KeyError as e:
                raise HTTPException(status_code=404, detail=str(e))

            template = self.template_engine.get(req.template_name)
            provider_type = req.provider or (template.provider.value if template else "email")

            try:
                provider = NotificationProvider(provider_type)
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Invalid provider: {provider_type}")

            try:
                priority = NotificationPriority(req.priority)
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Invalid priority: {req.priority}")

            notification = Notification(
                id=str(uuid.uuid4()),
                provider=provider,
                recipient=req.recipient,
                subject=subject,
                body=body,
                priority=priority,
                template_name=req.template_name,
                template_vars=req.variables,
                metadata=req.metadata,
            )

            self.queue.enqueue(notification)
            result = self.queue.process_next()

            if result and result.success:
                return _notification_to_response(notification)

            if notification.status == NotificationStatus.RETRYING:
                return _notification_to_response(notification)

            raise HTTPException(
                status_code=502,
                detail={
                    "message": "Failed to send notification",
                    "error": notification.error_message,
                    "notification_id": notification.id,
                },
            )

        # ── Get Notification ──────────────────────────────────────────

        @app.get("/notifications/{notification_id}", response_model=NotificationResponse)
        async def get_notification(notification_id: str):
            notification = self.queue.get_by_id(notification_id)
            if notification is None:
                raise HTTPException(status_code=404, detail="Notification not found")
            return _notification_to_response(notification)

        # ── List Notifications ────────────────────────────────────────

        @app.get("/notifications")
        async def list_notifications(status: Optional[str] = None):
            if status == "pending":
                notifications = self.queue.list_pending()
            elif status == "failed":
                notifications = self.queue.list_failed()
            elif status == "sent":
                notifications = self.queue.list_sent()
            else:
                notifications = (
                    self.queue.list_pending()
                    + self.queue.list_failed()
                    + self.queue.list_sent()
                )
            return [_notification_to_response(n) for n in notifications]

        # ── Cancel Notification ───────────────────────────────────────

        @app.delete("/notifications/{notification_id}")
        async def cancel_notification(notification_id: str):
            cancelled = self.queue.cancel(notification_id)
            if not cancelled:
                raise HTTPException(status_code=404, detail="Notification not found or already processed")
            return {"status": "cancelled", "notification_id": notification_id}

        # ── Queue Status ──────────────────────────────────────────────

        @app.get("/queue/status", response_model=QueueStatusResponse)
        async def queue_status():
            return QueueStatusResponse(
                pending=self.queue.get_queue_length(),
                failed=self.queue.get_failed_count(),
                sent=self.queue.get_sent_count(),
            )

        # ── Retry Failed ──────────────────────────────────────────────

        @app.post("/queue/retry", response_model=RetryResponse)
        async def retry_failed():
            results = self.queue.retry_failed()
            return RetryResponse(
                retried=len(results),
                results=[r.to_dict() for r in results],
            )

        # ── Templates ─────────────────────────────────────────────────

        @app.post("/templates", response_model=TemplateResponse)
        async def create_template(req: TemplateCreateRequest):
            try:
                provider = NotificationProvider(req.provider)
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Invalid provider: {req.provider}")

            template = Template(
                name=req.name,
                subject_template=req.subject_template,
                body_template=req.body_template,
                provider=provider,
                variables=req.variables,
            )
            self.template_engine.register(template)
            return TemplateResponse(
                name=template.name,
                subject_template=template.subject_template,
                body_template=template.body_template,
                provider=template.provider.value,
                variables=template.variables,
            )

        @app.get("/templates", response_model=list[TemplateResponse])
        async def list_templates():
            return [
                TemplateResponse(
                    name=t.name,
                    subject_template=t.subject_template,
                    body_template=t.body_template,
                    provider=t.provider.value,
                    variables=t.variables,
                )
                for t in self.template_engine.list_templates()
            ]

        @app.get("/templates/{template_name}", response_model=TemplateResponse)
        async def get_template(template_name: str):
            template = self.template_engine.get(template_name)
            if template is None:
                raise HTTPException(status_code=404, detail="Template not found")
            return TemplateResponse(
                name=template.name,
                subject_template=template.subject_template,
                body_template=template.body_template,
                provider=template.provider.value,
                variables=template.variables,
            )

        @app.delete("/templates/{template_name}")
        async def delete_template(template_name: str):
            removed = self.template_engine.remove(template_name)
            if not removed:
                raise HTTPException(status_code=404, detail="Template not found")
            return {"status": "deleted", "template_name": template_name}

        # ── Webhook Receiver ──────────────────────────────────────────

        @app.post("/webhook/receive")
        async def receive_webhook(payload: WebhookPayload):
            """Receive external webhook events and create notifications."""
            event = payload.event
            data = payload.payload

            # Map webhook events to notifications
            recipient = data.get("recipient", "unknown")
            subject = data.get("subject", f"Webhook Event: {event}")
            body = data.get("body", str(data))
            provider_str = data.get("provider", "email")

            try:
                provider = NotificationProvider(provider_str)
            except ValueError:
                provider = NotificationProvider.EMAIL

            notification = Notification(
                id=str(uuid.uuid4()),
                provider=provider,
                recipient=recipient,
                subject=subject,
                body=body,
                priority=NotificationPriority(data.get("priority", "medium")),
                metadata={"webhook_event": event, **data},
            )

            self.queue.enqueue(notification)
            return {
                "status": "received",
                "notification_id": notification.id,
                "event": event,
            }

        return app


def _notification_to_response(n: Notification) -> NotificationResponse:
    return NotificationResponse(
        id=n.id,
        provider=n.provider.value,
        recipient=n.recipient,
        subject=n.subject,
        body=n.body,
        priority=n.priority.value,
        status=n.status.value,
        template_name=n.template_name,
        template_vars=n.template_vars,
        metadata=n.metadata,
        created_at=n.created_at.isoformat(),
        updated_at=n.updated_at.isoformat(),
        retry_count=n.retry_count,
        max_retries=n.max_retries,
        error_message=n.error_message,
    )


def create_app(
    email_config: Optional[dict[str, Any]] = None,
    slack_webhook_url: Optional[str] = None,
    webhook_url: Optional[str] = None,
    persist_path: Optional[str] = None,
) -> FastAPI:
    """Convenience factory to create a configured FastAPI app."""
    retry_handler = RetryHandler(max_retries=3, base_delay=1.0)
    queue = NotificationQueue(retry_handler=retry_handler, persist_path=persist_path)
    template_engine = TemplateEngine()

    api = NotificationAPI(
        queue=queue,
        template_engine=template_engine,
        email_config=email_config,
        slack_webhook_url=slack_webhook_url,
        webhook_url=webhook_url,
    )
    return api.app

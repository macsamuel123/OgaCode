"""Minimal OgaCode proxy server.

Validates user token and forwards requests to DeepSeek/Groq using server-held keys.
This is the entry point for Railway — keeps imports minimal to avoid crash loops.
"""
import asyncio
import hashlib
import hmac
import os
from collections import defaultdict
print(f"[OgaCode] PORT env var = {os.getenv('PORT', 'NOT SET')}", flush=True)
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

# ── Valid tokens (comma-separated in env) ────────────────────────────────────
_RAW_TOKENS = os.getenv("VALID_TOKENS", "").strip()
VALID_TOKENS: set[str] = set(t.strip() for t in _RAW_TOKENS.split(",") if t.strip())

def _check_token(auth_header: str) -> None:
    token = auth_header.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing OgaCode token. Set ogacode.token in VS Code settings.")
    if VALID_TOKENS and token not in VALID_TOKENS:
        raise HTTPException(status_code=401, detail="Invalid OgaCode token.")

# ── Request body size limit (1 MB) ───────────────────────────────────────────
class _BodySizeLimit(BaseHTTPMiddleware):
    _MAX = 1_000_000  # 1 MB

    async def dispatch(self, request: Request, call_next):
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > self._MAX:
            return Response("Request body too large.", status_code=413)
        return await call_next(request)

app = FastAPI(title="OgaCode Proxy", version="1.0.0")

app.add_middleware(_BodySizeLimit)
app.add_middleware(GZipMiddleware, minimum_size=512)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "deepseek": bool(os.getenv("DEEPSEEK_API_KEY")),
        "groq": bool(os.getenv("GROQ_API_KEY")),
    }


@app.get("/v1/models")
async def list_models(request: Request):
    """OpenAI-compat model list — required by the openclaude SDK on startup."""
    _check_token(request.headers.get("authorization", ""))
    return JSONResponse({"object": "list", "data": [
        {"id": "deepseek-chat", "object": "model", "owned_by": "deepseek"},
        {"id": "moonshotai/kimi-k2-instruct", "object": "model", "owned_by": "groq"},
    ]})


@app.post("/v1/chat/completions")
async def openai_proxy(request: Request):
    _check_token(request.headers.get("authorization", ""))

    body = await request.json()
    streaming = body.get("stream", False)

    deepseek_key = os.getenv("DEEPSEEK_API_KEY")
    groq_key = os.getenv("GROQ_API_KEY")

    if deepseek_key:
        target = "https://api.deepseek.com/v1/chat/completions"
        api_key = deepseek_key
    elif groq_key:
        target = "https://api.groq.com/openai/v1/chat/completions"
        api_key = groq_key
        if body.get("model") == "deepseek-chat":
            body["model"] = "moonshotai/kimi-k2-instruct"
    else:
        raise HTTPException(status_code=503, detail="No LLM provider configured on server.")

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    if streaming:
        async def _stream():
            # SSE comment keepalives every 20 s prevent Railway's reverse proxy
            # from closing the connection during slow LLM responses.
            queue: asyncio.Queue[bytes | None] = asyncio.Queue()

            async def _fetch() -> None:
                try:
                    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
                        async with client.stream("POST", target, json=body, headers=headers) as resp:
                            async for chunk in resp.aiter_bytes():
                                await queue.put(chunk)
                except Exception:
                    await queue.put(b'data: {"error":"Service temporarily unavailable"}\n\ndata: [DONE]\n\n')
                finally:
                    await queue.put(None)

            asyncio.create_task(_fetch())

            while True:
                try:
                    chunk = await asyncio.wait_for(queue.get(), timeout=20.0)
                    if chunk is None:
                        break
                    yield chunk
                except asyncio.TimeoutError:
                    yield b': keepalive\n\n'  # SSE comment — invisible to clients, keeps connection alive

        return StreamingResponse(
            _stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    async with httpx.AsyncClient(timeout=90.0) as client:
        resp = await client.post(target, json=body, headers=headers)
    return JSONResponse(content=resp.json(), status_code=resp.status_code)


@app.post("/v1/vision")
async def vision_proxy(request: Request):
    """
    One-shot image description endpoint — always uses Groq's vision model.
    DeepSeek is text-only; this route is kept separate so vision never
    touches the main LLM provider and never inflates DeepSeek costs.

    Request body: { "image": "<base64 data URL>", "prompt": "optional instruction" }
    Response:     { "description": "<text>" }
    """
    _check_token(request.headers.get("authorization", ""))

    groq_key = os.getenv("GROQ_API_KEY")
    if not groq_key:
        raise HTTPException(status_code=503, detail="Vision unavailable: no GROQ_API_KEY on server.")

    body = await request.json()
    image_url = body.get("image", "")
    prompt = body.get("prompt", "Describe this screenshot in detail for a developer debugging a bug. Include all visible error messages, UI state, code, stack traces, and console output.")

    if not image_url:
        raise HTTPException(status_code=400, detail="Missing 'image' field (base64 data URL).")

    payload = {
        "model": "llama-3.2-11b-vision-preview",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_url}},
            ],
        }],
        "max_tokens": 800,
    }
    headers = {"Authorization": f"Bearer {groq_key}", "Content-Type": "application/json"}

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                json=payload, headers=headers,
            )
        data = resp.json()
        description = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        return JSONResponse({"description": description})
    except Exception:
        raise HTTPException(status_code=502, detail="Vision processing failed. Please try again.")


# ── Paystack billing webhook ──────────────────────────────────────────────────

@app.post("/webhook/paystack")
async def paystack_webhook(request: Request) -> dict:
    payload = await request.body()
    signature = request.headers.get("x-paystack-signature", "")
    secret = os.getenv("PAYSTACK_SECRET_KEY", "")
    if not secret:
        raise HTTPException(status_code=500, detail="Webhook secret not configured")
    expected = hmac.new(secret.encode(), payload, hashlib.sha512).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")
    event_data: dict = await request.json()
    event_type: str = event_data.get("event", "unknown")
    # TODO: handle subscription.create → provision credits
    # TODO: handle charge.success → resume suspended account
    # TODO: handle subscription.disable → suspend account
    return {"received": True, "event": event_type}


# ── Opt-in telemetry (in-memory, resets on restart) ──────────────────────────

_telemetry: dict = defaultdict(int)

@app.post("/telemetry")
async def record_telemetry(request: Request) -> dict:
    body = await request.json()
    event = str(body.get("event", "unknown"))[:64]
    _telemetry[event] += 1
    return {"ok": True}

@app.get("/telemetry/summary")
async def telemetry_summary() -> dict:
    return dict(_telemetry)


# ── Agent task execution (used by Lovable web frontend) ──────────────────────
# Requires OGACODE_SERVER_URL + OGACODE_TOKEN env vars on Railway so the
# agent can make LLM calls back through this server.

from pydantic import BaseModel  # noqa: E402

class TaskRequest(BaseModel):
    task: str

@app.post("/v1/task")
async def run_task(req: TaskRequest, request: Request):
    """
    Accept a plain-text task, run the OgaCode agent, stream back SSE events.

    Each event: data: {"type": "narrative"|"pre_tool"|"post_tool"|"stop", ...}
    Final event: data: {"type": "stop", "success": true/false, "files": [...]}
    """
    _check_token(request.headers.get("authorization", ""))

    async def event_stream():
        import tempfile
        from pathlib import Path

        try:
            from ogacode.agent.events import EventBus, NARRATIVE, PRE_TOOL, POST_TOOL, STOP
            from ogacode.agent.loop import agent_loop
        except ImportError as exc:
            yield f'data: {json.dumps({"type": "error", "text": f"Agent not installed on server: {exc}"})}\n\n'
            return

        work_dir = Path(tempfile.mkdtemp(prefix="ogacode_task_"))
        queue: asyncio.Queue[dict] = asyncio.Queue()
        bus = EventBus()

        def make_handler(ev_type: str):
            def handler(ev: dict) -> None:
                queue.put_nowait({"type": ev_type, **ev})
            return handler

        for ev_type in (NARRATIVE, PRE_TOOL, POST_TOOL, STOP):
            bus.on(ev_type, make_handler(ev_type))

        agent_task = asyncio.create_task(
            agent_loop(req.task, cwd=work_dir, bus=bus)
        )

        try:
            while True:
                try:
                    ev = await asyncio.wait_for(queue.get(), timeout=0.2)
                    yield f"data: {json.dumps(ev)}\n\n"
                    if ev.get("type") == STOP:
                        break
                except asyncio.TimeoutError:
                    if agent_task.done():
                        # Drain any remaining events before closing
                        while not queue.empty():
                            ev = queue.get_nowait()
                            yield f"data: {json.dumps(ev)}\n\n"
                        break
                    yield ": heartbeat\n\n"
        except Exception as exc:
            yield f'data: {json.dumps({"type": "error", "text": str(exc)})}\n\n'
        finally:
            if not agent_task.done():
                agent_task.cancel()
                try:
                    await agent_task
                except asyncio.CancelledError:
                    pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

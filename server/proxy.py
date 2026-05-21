"""Minimal OgaCode proxy server.

Validates user token and forwards requests to DeepSeek/Groq using server-held keys.
This is the entry point for Railway — keeps imports minimal to avoid crash loops.
"""
import os
print(f"[OgaCode] PORT env var = {os.getenv('PORT', 'NOT SET')}", flush=True)
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse

app = FastAPI(title="OgaCode Proxy", version="1.0.0")

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


@app.post("/v1/chat/completions")
async def openai_proxy(request: Request):
    auth = request.headers.get("authorization", "")
    token = auth.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing OgaCode token. Set ogacode.token in VS Code settings.")

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
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
                    async with client.stream("POST", target, json=body, headers=headers) as resp:
                        async for chunk in resp.aiter_bytes():
                            yield chunk
            except Exception as e:
                yield f'data: {{"error":"{str(e)}"}}\n\ndata: [DONE]\n\n'.encode()

        return StreamingResponse(
            _stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    async with httpx.AsyncClient(timeout=90.0) as client:
        resp = await client.post(target, json=body, headers=headers)
    return JSONResponse(content=resp.json(), status_code=resp.status_code)

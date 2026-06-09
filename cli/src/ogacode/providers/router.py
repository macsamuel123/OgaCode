import asyncio
import json
import os

import httpx

from ogacode.cache import get_cached, set_cached


class LLMError(Exception):
    pass


class AllProvidersFailedError(LLMError):
    pass


async def call_llm(
    messages: list[dict],
    tools: list[dict] | None = None,
    *,
    on_provider=None,
) -> dict:
    """Call the OgaCode managed server. Requires OGACODE_SERVER_URL + OGACODE_TOKEN."""
    server_url = os.getenv("OGACODE_SERVER_URL", "").rstrip("/")
    token = os.getenv("OGACODE_TOKEN", "")

    if not server_url or not token:
        raise AllProvidersFailedError(
            "OgaCode token not configured. Add it in VS Code settings (ogacode.token)."
        )

    # Semantic cache: only for simple single-turn completions with no tools
    cache_prompt: str | None = None
    if not tools and len(messages) == 2 and messages[1]["role"] == "user":
        cache_prompt = messages[1]["content"]
        cached = get_cached(cache_prompt)
        if cached:
            return {"choices": [{"message": {"role": "assistant", "content": cached}, "finish_reason": "stop"}]}

    if on_provider:
        on_provider("ogacode")

    payload: dict = {
        "model": "deepseek-chat",
        "messages": messages,
        "temperature": 0.1,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip",
    }

    debug = os.getenv("OGACODE_DEBUG", "").lower() in ("1", "true")

    last_error: Exception | None = None
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(f"{server_url}/v1/chat/completions", headers=headers, json=payload)

            if debug:
                import sys
                print(f"[OGACODE_DEBUG] → {resp.status_code} "
                      f"({len(resp.content)} bytes, encoding={resp.headers.get('content-encoding', 'none')})",
                      file=sys.stderr)

            if resp.status_code == 401:
                raise AllProvidersFailedError("Invalid OgaCode token. Check your token in VS Code settings (ogacode.token).")
            if resp.status_code == 429:
                raise AllProvidersFailedError("Usage limit reached. Upgrade your plan at ogacode.dev.")

            # 502/503/504 are transient — retry with backoff
            if resp.status_code in (502, 503, 504):
                if attempt < 2:
                    await asyncio.sleep(2 ** attempt)   # 1s, 2s
                    continue
                raise AllProvidersFailedError(f"Server error {resp.status_code}: {resp.text[:200]}")

            if not resp.is_success:
                raise AllProvidersFailedError(f"Server error {resp.status_code}: {resp.text[:200]}")

            result = resp.json()

            if cache_prompt:
                content = result["choices"][0]["message"].get("content", "")
                set_cached(cache_prompt, content, bytes_used=len(json.dumps(messages).encode()))

            return result

        except httpx.TimeoutException as exc:
            last_error = exc
            if attempt < 2:
                await asyncio.sleep(2 ** attempt)
                continue
            raise AllProvidersFailedError("OgaCode server timed out. Check your connection.") from exc
        except AllProvidersFailedError:
            raise
        except Exception as exc:
            raise AllProvidersFailedError(f"Connection error: {exc}") from exc

    raise AllProvidersFailedError(f"Connection error: {last_error}")

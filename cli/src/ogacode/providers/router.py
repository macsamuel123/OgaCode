import json
import time
from typing import Any, Callable

import httpx

from ogacode.cache import get_cached, set_cached
from ogacode.keychain import get_api_key

_PROVIDERS = [
    {
        "name": "deepseek",
        "base_url": "https://api.deepseek.com/v1",
        "model": "deepseek-chat",
        "key_name": "deepseek_api_key",
        "timeout": 60,
    },
    {
        "name": "groq",
        "base_url": "https://api.groq.com/openai/v1",
        "model": "qwen/qwen3-32b",
        "key_name": "groq_api_key",
        "timeout": 30,
    },
    {
        "name": "ollama",
        "base_url": "http://localhost:11434/v1",
        "model": "qwen2.5-coder:7b",
        "key_name": None,  # no auth needed for local Ollama
        "timeout": 30,
    },
]

_backoff: dict[str, float] = {}


class LLMError(Exception):
    pass


class AllProvidersFailedError(LLMError):
    pass


async def call_llm(
    messages: list[dict],
    tools: list[dict] | None = None,
    *,
    on_provider: Callable[[str], None] | None = None,
) -> dict:
    """Call LLM with automatic fallback: DeepSeek → Groq → Ollama.

    Caches simple single-turn completions to save data. Gzips all payloads.
    """
    # Semantic cache: only for simple user→assistant turns with no tools
    cache_prompt: str | None = None
    if not tools and len(messages) == 2 and messages[1]["role"] == "user":
        cache_prompt = messages[1]["content"]
        cached = get_cached(cache_prompt)
        if cached:
            return {"choices": [{"message": {"role": "assistant", "content": cached}, "finish_reason": "stop"}]}

    last_err: Exception | None = None

    for provider in _PROVIDERS:
        key_name = provider["key_name"]
        api_key = get_api_key(key_name) if key_name else "ollama"
        if key_name and not api_key:
            continue  # skip unconfigured cloud providers

        if on_provider:
            on_provider(provider["name"])

        try:
            result = await _call(provider, api_key or "ollama", messages, tools)

            if cache_prompt:
                content = result["choices"][0]["message"].get("content", "")
                set_cached(cache_prompt, content, bytes_used=len(json.dumps(messages).encode()))

            return result

        except (httpx.TimeoutException, LLMError) as exc:
            last_err = exc
            await _backoff_wait(provider["name"])

    detail = f" ({type(last_err).__name__}: {last_err})" if last_err else ""
    raise AllProvidersFailedError(
        f"All LLM providers failed.{detail}"
    ) from last_err


async def _call(
    provider: dict[str, Any],
    api_key: str,
    messages: list[dict],
    tools: list[dict] | None,
) -> dict:
    payload: dict[str, Any] = {
        "model": provider["model"],
        "messages": messages,
        "temperature": 0.1,  # low = deterministic code, less hallucination
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip",  # reduces data cost on mobile
    }

    async with httpx.AsyncClient(timeout=provider["timeout"]) as client:
        resp = await client.post(f"{provider['base_url']}/chat/completions", headers=headers, json=payload)

    if resp.status_code == 429:
        raise LLMError(f"Rate limited by {provider['name']} — try again in a moment")
    if not resp.is_success:
        raise LLMError(f"{provider['name']} returned HTTP {resp.status_code}: {resp.text[:200]}")

    return resp.json()


async def _backoff_wait(provider_name: str) -> None:
    import asyncio
    attempts_key = f"{provider_name}:attempts"
    attempts = int(_backoff.get(attempts_key, 0))
    # 2s → 5s → 10s
    wait = min(2.0 * (2 ** attempts), 10.0)
    _backoff[attempts_key] = attempts + 1
    _backoff[provider_name] = time.time()
    await asyncio.sleep(wait)

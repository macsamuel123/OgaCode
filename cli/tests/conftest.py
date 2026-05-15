import asyncio
import pytest
from pathlib import Path
from ogacode.agent.events import EventBus
from ogacode.agent.loop import agent_loop, AgentResult


async def run(task: str, tmp_path: Path) -> tuple[AgentResult, list[dict]]:
    """Run the agent loop and collect all emitted events."""
    events: list[dict] = []
    bus = EventBus()
    bus.on_any(events.append)
    result = await agent_loop(task=task, cwd=tmp_path, bus=bus, use_supervisor=False)
    return result, events


def event_types(events: list[dict]) -> list[str]:
    return [e["type"] for e in events]


def tools_called(events: list[dict]) -> list[str]:
    return [e["tool"] for e in events if e["type"] == "pre_tool_use"]


def file_exists_with(path: Path, *keywords: str) -> bool:
    if not path.exists():
        return False
    text = path.read_text(encoding="utf-8", errors="replace").lower()
    return all(kw.lower() in text for kw in keywords)

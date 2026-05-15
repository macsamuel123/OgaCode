from collections import defaultdict
from typing import Any, Callable

# Named event types — mirrors Claude Code hook names
THINKING  = "thinking"    # LLM is processing a step
PRE_TOOL  = "pre_tool_use"   # about to call a tool
POST_TOOL = "post_tool_use"  # tool finished
CORRECTION = "correction"    # tool failed, asking LLM to retry
SUPERVISOR = "supervisor"    # supervisor reviewing work
ESCALATE  = "escalate"    # agent needs human input
STOP      = "stop"        # agent finished (success or failure)
PROVIDER  = "provider"    # switched to a provider


class EventBus:
    """
    Minimal pub/sub bus. Listeners registered with .on(event_type) receive only
    that event type. Listeners registered with .on_any() receive all events.
    """

    def __init__(self) -> None:
        self._listeners: dict[str, list[Callable[[dict[str, Any]], None]]] = defaultdict(list)

    def on(self, event_type: str, listener: Callable[[dict[str, Any]], None]) -> None:
        self._listeners[event_type].append(listener)

    def on_any(self, listener: Callable[[dict[str, Any]], None]) -> None:
        self._listeners["*"].append(listener)

    def emit(self, event_type: str, **data: Any) -> None:
        event = {"type": event_type, **data}
        for fn in self._listeners.get(event_type, []):
            fn(event)
        for fn in self._listeners.get("*", []):
            fn(event)

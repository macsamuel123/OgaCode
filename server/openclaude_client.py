"""Async gRPC client for the OpenClaude agent server.

OpenClaude must be running in gRPC mode before any request is made:
    openclaude --grpc      # listens on localhost:50051

The main entry point is stream_task(), which opens a bidirectional
Chat() RPC and yields ServerMessage objects as they arrive.

For plan/command approvals sent by OpenClaude (ActionRequired events),
the UI layer calls send_approval() with the session_id and prompt_id.
The approval is forwarded into the open gRPC request stream.
"""

import asyncio
from collections.abc import AsyncIterator

import grpc
import grpc.aio

try:
    from openclaude_pb2 import ClientMessage, ChatRequest, UserInput, CancelSignal  # type: ignore
    import openclaude_pb2_grpc as _pb2_grpc  # type: ignore
    _STUBS_AVAILABLE = True
except ModuleNotFoundError:
    _STUBS_AVAILABLE = False

GRPC_ADDR = "localhost:50051"

# Per-session queues: session_id → Queue[UserInput | None]
# None is the sentinel that closes the request stream.
_approval_queues: dict[str, asyncio.Queue] = {}


def _check_stubs() -> None:
    if not _STUBS_AVAILABLE:
        raise RuntimeError(
            "OpenClaude gRPC stubs not generated yet.\n"
            "Run: python -m grpc_tools.protoc -I server/proto "
            "--python_out=server --grpc_python_out=server "
            "server/proto/openclaude.proto"
        )


async def stream_task(
    message: str,
    cwd: str,
    session_id: str,
) -> AsyncIterator:
    """Open a Chat() bidirectional gRPC stream and yield ServerMessage objects."""
    _check_stubs()

    queue: asyncio.Queue = asyncio.Queue()
    _approval_queues[session_id] = queue

    async def _requests():
        yield ClientMessage(request=ChatRequest(
            message=message,
            working_directory=cwd,
            session_id=session_id,
        ))
        while True:
            item = await queue.get()
            if item is None:  # sentinel — close the request stream
                return
            yield ClientMessage(input=item)

    try:
        async with grpc.aio.insecure_channel(GRPC_ADDR) as channel:
            stub = _pb2_grpc.AgentServiceStub(channel)
            async for msg in stub.Chat(_requests()):
                yield msg
    finally:
        _approval_queues.pop(session_id, None)


def send_approval(session_id: str, prompt_id: str, reply: str = "y") -> bool:
    """Forward a plan/command approval into the live gRPC request stream."""
    q = _approval_queues.get(session_id)
    if not q:
        return False
    q.put_nowait(UserInput(reply=reply, prompt_id=prompt_id))
    return True


def cancel_task(session_id: str) -> None:
    """Close the request stream for a session (sends sentinel to the generator)."""
    q = _approval_queues.pop(session_id, None)
    if q:
        q.put_nowait(None)

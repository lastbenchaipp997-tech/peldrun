# backend/omweb/agent_bridge_parts/dispatcher/chat_llm_call.py
"""
Chat-mode LLM invocation: SSE stream handlers + adapter execution policy.

Extracted verbatim from ``run_direct_chat``.

EXECUTION POLICY (order is load-bearing)
----------------------------------------
  1. Create the adapter through ``provider_factory`` -- ONE entry point for
     built-in, native and Store-installed plugin providers alike.
  2. Try STREAMING first, so SSE deltas fire as tokens arrive.
  3. ``asyncio.CancelledError`` is re-raised untouched. Swallowing it would
     break user-initiated Stop and the cancellation ledger record.
  4. An OOM error is re-raised immediately, NEVER retried. The retry would
     allocate again on top of memory the failed attempt did not free, and
     fail with a worse error.
  5. Any other streaming failure falls back to a single non-streaming
     ``generate`` call.
  6. ``adapter.close()`` ALWAYS runs in ``finally``, and its own failure is
     swallowed at DEBUG -- a close error must not mask the real result or
     the real exception.

The ``adapter = None`` initialization matters: if ``provider_factory.create``
raises, ``finally`` must not attempt to close a half-built object.

SSE HANDLER PAYLOADS
--------------------
Both handlers deliberately send the same text under THREE keys
(``delta`` / ``text`` / ``content``, plus ``thought`` for thoughts). Different
frontend consumers read different keys; dropping any of them silently breaks
one of the renderers. The thought handler additionally sets ``is_delta=True``
so the UI appends rather than replaces.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

from omweb.sse_events import SSEEvent, SSEEventType, dispatch_event
from peldrun.llm.client import _is_oom_error
from peldrun.llm.providers import provider_factory
from peldrun.llm.stream_normalizer import collect_response

logger = logging.getLogger(__name__)


def make_chunk_handler(
    job_id: str,
    model_name: str,
) -> Callable[[str], Awaitable[None]]:
    """Build the assistant-text delta handler bound to a job/model."""

    async def _handle_chunk(delta_text: str) -> None:
        await dispatch_event(
            job_id,
            SSEEvent(
                type=SSEEventType.CHUNK,
                step=1,
                data={
                    "delta": delta_text,
                    "text": delta_text,
                    "content": delta_text,
                    "model": model_name,
                },
            ),
        )

    return _handle_chunk


def make_thought_chunk_handler(
    job_id: str,
    model_name: str,
) -> Callable[[str], Awaitable[None]]:
    """Build the reasoning-trace delta handler bound to a job/model."""

    async def _handle_thought_chunk(thought_delta: str) -> None:
        await dispatch_event(
            job_id,
            SSEEvent(
                type=SSEEventType.THOUGHT,
                step=1,
                data={
                    "delta": thought_delta,
                    "thought": thought_delta,
                    "content": thought_delta,
                    "is_delta": True,
                    "model": model_name,
                },
            ),
        )

    return _handle_thought_chunk


async def invoke_chat_llm(
    *,
    adapter_provider_id: str,
    connection: Any,
    llm_request: Any,
    model_name: str,
    on_chunk: Callable[[str], Awaitable[None]],
    on_thought_chunk: Callable[[str], Awaitable[None]],
) -> Any:
    """
    Execute the chat completion and return the normalized response.

    Raises whatever the provider raises when both streaming and the
    non-streaming fallback fail, plus CancelledError and OOM errors
    unchanged. The caller's error handler owns job failure + ledger.
    """
    adapter = None
    try:
        adapter = provider_factory.create(adapter_provider_id, connection)
        try:
            response = await collect_response(
                adapter.stream(llm_request),
                model=model_name,
                on_chunk=on_chunk,
                on_thought_chunk=on_thought_chunk,
            )
        except asyncio.CancelledError:
            raise
        except Exception as stream_err:
            if _is_oom_error(stream_err):
                logger.error(
                    "[BRIDGE DIRECT CHAT] OOM detected for model %r: %s. "
                    "Not retrying.",
                    model_name,
                    stream_err,
                )
                raise
            logger.warning(
                "[BRIDGE DIRECT CHAT] Streaming call failed (%s). "
                "Falling back to non-streaming.",
                stream_err,
            )
            response = await adapter.generate(llm_request)
    finally:
        if adapter is not None:
            try:
                await adapter.close()
            except Exception as close_err:
                logger.debug(
                    "[BRIDGE DIRECT CHAT] adapter.close() raised: %s",
                    close_err,
                )
    return response


__all__ = [
    "make_chunk_handler",
    "make_thought_chunk_handler",
    "invoke_chat_llm",
]

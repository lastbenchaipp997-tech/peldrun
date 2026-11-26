# backend/omweb/agent_bridge_parts/dispatcher/memory_bridge.py
"""
Memory subsystem bridge for BOTH dispatch modes.

Four entry points, extracted verbatim. They are NOT unified, because the
two modes have materially different observability and failure contracts.

PRESERVED ASYMMETRIES (do not "unify" these)
--------------------------------------------
1. RETRIEVAL FAILURE VISIBILITY
   Agent : ``logger.warning(..., exc_info=True)`` PLUS
           ``record_retrieval_failure()`` so the failure is counted.
           Rationale in the original: a retrieval failure must never look
           like "empty memory" at DEBUG level.
   Chat  : ``logger.debug(...)`` only, no counter.
   Chat failures are therefore effectively invisible. That is a real
   pre-existing gap; fixing it changes monitoring output and is a
   separate decision.

2. RETRIEVAL SUCCESS CHANNEL
   Agent : ``logger.info`` with ``%d``/``%s`` formatting.
   Chat  : ``print`` to stdout.

3. AFTER-TURN FAILURE VISIBILITY
   Agent : ``logger.debug``.
   Chat  : ``logger.warning(..., exc_info=True)`` plus per-hook timing
           logs at INFO (added to diagnose a perceived "chat freeze").

SHARED INVARIANTS
-----------------
* Query is ALWAYS the ORIGINAL user prompt, never the augmented prompt.
  The router's greeting/length heuristics expect user input; feeding it
  injected file contents or web results misclassifies a "hi" as a real
  query.
* Every function is best-effort and NEVER raises. The after-turn hooks
  run AFTER ``complete_job``; an escaping exception would reach the
  dispatch error handler and overwrite a successfully completed job with
  "failed", leaving the user with a visible answer but a failed job on
  refresh.
* Turn count is read via ``project_manager.get_chat(job_id)`` -- keyed by
  JOB id, not chat id, exactly as the original. Both files must already
  be on disk (session.json + sidecar) before the hook runs, or the
  extraction worker's snapshot guard fires spuriously.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from omweb.project_manager import project_manager

logger = logging.getLogger(__name__)


async def retrieve_for_agent(
    job_id: str,
    prompt: str,
    chat_id: str,
    project_id: str,
) -> Optional[Any]:
    """
    Retrieve memory context for an agent run. Returns None on failure.

    ``MemoryService.retrieve`` returns an empty MemoryContext (never
    None) on expected failures. The try/except is defense in depth for
    ``get_memory_service()`` raising when the FastAPI lifespan hook did
    not run.
    """
    memory_context = None
    try:
        from omweb.memory import get_memory_service
        _mem_service = get_memory_service()
        _retrieved = await _mem_service.retrieve(
            query=prompt,
            chat_id=chat_id,
            project_id=project_id,
            user_id="default",
            run_id=job_id,
        )
        if _retrieved is not None and not _retrieved.is_empty:
            logger.info(
                "[BRIDGE] Memory retrieved for job %s: %d entries, "
                "%d tokens (router=%s).",
                job_id,
                len(_retrieved.memories),
                _retrieved.used_tokens,
                _retrieved.router_decision,
            )
        memory_context = _retrieved
    except Exception as _mem_err:
        logger.warning(
            "[BRIDGE] Memory retrieval failed for job %s: %s",
            job_id,
            _mem_err,
            exc_info=True,
        )
        try:
            # NOTE: ``_mem_service`` may be unbound if
            # ``get_memory_service()`` itself raised. The resulting
            # NameError is swallowed below -- identical to the original.
            # Do not "harden" this by pre-initializing the variable: that
            # would change which failures get counted.
            _mem_service.record_retrieval_failure(_mem_err)
        except Exception:  # noqa: BLE001 -- observability is best-effort
            pass
        memory_context = None
    return memory_context


async def retrieve_for_chat(
    job_id: str,
    prompt: str,
    chat_id: str,
    project_id: str,
) -> Optional[Any]:
    """
    Retrieve memory context for a chat turn. Returns None on failure.

    Same query semantics as agent mode, different observability (see the
    module docstring, asymmetries 1 and 2).
    """
    memory_context = None
    try:
        from omweb.memory import get_memory_service
        _mem_service = get_memory_service()
        _retrieved = await _mem_service.retrieve(
            query=prompt,
            chat_id=chat_id,
            project_id=project_id,
            user_id="default",
            run_id=job_id,
        )
        if _retrieved is not None and not _retrieved.is_empty:
            print(
                f"[BRIDGE DIRECT CHAT] Memory retrieved for job "
                f"{job_id}: {len(_retrieved.memories)} entries, "
                f"{_retrieved.used_tokens} tokens "
                f"(router={_retrieved.router_decision})."
            )
        memory_context = _retrieved
    except Exception as _mem_err:
        logger.debug(
            "[BRIDGE DIRECT CHAT] Memory retrieval skipped for "
            "job %s: %s",
            job_id,
            _mem_err,
        )
        memory_context = None
    return memory_context


async def notify_after_turn_agent(
    job_id: str,
    chat_id: str,
    project_id: str,
) -> None:
    """
    Agent-mode After-Turn / After-Session extraction hook.

    MUST be called only after the engine has completed the job, synced
    the sidecar and dispatched its own FINAL event. Without this hook
    agent conversations would never trigger extraction at all.

    Both notify_* methods self-guard on ``extraction_trigger``; calling
    them unconditionally is safe and is what the original did.
    """
    try:
        from omweb.memory import get_memory_service
        _mem_svc = get_memory_service()
        if _mem_svc is not None and _mem_svc.extraction_enabled:
            _chat_after = (
                project_manager.get_chat(job_id) or {}
            )
            _turns_after = _chat_after.get("turns") or []
            if _turns_after:
                await _mem_svc.notify_turn_completed(
                    chat_id=chat_id,
                    project_id=project_id,
                    current_turn_index=len(_turns_after) - 1,
                )
                await _mem_svc.notify_session_updated(
                    chat_id=chat_id,
                    project_id=project_id,
                )
    except Exception as _mem_hook_err:
        logger.debug(
            "[BRIDGE] After-Turn memory hook skipped "
            "for agent job %s: %s",
            job_id,
            _mem_hook_err,
        )


async def notify_after_turn_chat(
    job_id: str,
    chat_id: str,
    project_id: str,
) -> None:
    """
    Chat-mode After-Turn hook, with per-call timing instrumentation.

    MUST run AFTER ``complete_job`` (session.json) AND ``sync_sidecar``
    (session.context.json), and BEFORE the FINAL event is dispatched so
    the enqueue happens while the snapshot is stable.

    The hook stays awaited (not fire-and-forget). The timing logs exist
    to prove or disprove that this hook is the source of a perceived
    freeze; converting it to background execution is a larger behavioral
    change that must be justified by those numbers first.
    """
    try:
        import time as _time_mem
        from omweb.memory import get_memory_service
        _mem_svc = get_memory_service()
        if _mem_svc is not None and _mem_svc.extraction_enabled:
            _chat_after = project_manager.get_chat(job_id) or {}
            _turns_after = _chat_after.get("turns") or []
            if _turns_after:
                _hook_t0 = _time_mem.monotonic()
                await _mem_svc.notify_turn_completed(
                    chat_id=chat_id,
                    project_id=project_id,
                    current_turn_index=len(_turns_after) - 1,
                )
                _turn_ms = (_time_mem.monotonic() - _hook_t0) * 1000.0
                logger.info(
                    "[BRIDGE DIRECT CHAT] notify_turn_completed "
                    "took %.1f ms for job %s",
                    _turn_ms, job_id,
                )
                _hook_t1 = _time_mem.monotonic()
                await _mem_svc.notify_session_updated(
                    chat_id=chat_id,
                    project_id=project_id,
                )
                _session_ms = (
                    _time_mem.monotonic() - _hook_t1
                ) * 1000.0
                logger.info(
                    "[BRIDGE DIRECT CHAT] notify_session_updated "
                    "took %.1f ms for job %s",
                    _session_ms, job_id,
                )
    except Exception as _mem_hook_err:
        logger.warning(
            "[BRIDGE DIRECT CHAT] After-Turn memory hook "
            "failed for job %s: %s",
            job_id,
            _mem_hook_err,
            exc_info=True,
        )


__all__ = [
    "retrieve_for_agent",
    "retrieve_for_chat",
    "notify_after_turn_agent",
    "notify_after_turn_chat",
]

# backend/omweb/agent_bridge_parts/dispatcher/chat_accounting.py
"""
Chat-mode ledger accounting and turn-content persistence.

Extracted verbatim from ``run_direct_chat``. Four concerns, one owner:

  * ``record_chat_completion``   -- success ledger + per-turn usage
  * ``record_chat_cancellation`` -- Stop-button ledger record
  * ``record_chat_failure``      -- failure ledger record
  * ``enrich_last_turn``         -- user/assistant text into turns[]

WHY THE LEDGER RECORDS EVERY OUTCOME
------------------------------------
Before M8.2 only successful calls WITH usage were recorded. Cancellations
were invisible (a user pressing Stop after 30s of generation left no trace)
and usage-less responses were skipped entirely. ``default_tracker`` now
writes a record even when ``response.usage`` is None, tagging
``usage_source="unknown"`` / ``cost_status="unknown"`` so aggregations never
conflate "free" with "unknown pricing".

The per-turn session usage is still written ONLY when usage is present --
that mirrors the historical session summary shape. Ledger completeness and
session-summary shape are intentionally different.

``turn_id`` is derived from ``len(turns) + 1`` where ``turns`` is the snapshot
read at the START of the run. It is not recomputed after completion.

FAILURE ISOLATION
-----------------
The cancel/fail records are best-effort: an accounting error must never
replace the user-visible cancellation or error. ``enrich_last_turn`` is
likewise best-effort -- a write failure must not break a completed chat.

``enrich_last_turn`` is idempotent: it only fills fields that are still
empty, so a caller that populated them earlier short-circuits the write.
"""
from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from omweb.project_manager import project_manager
from peldrun.llm.accounting import InvocationContext, default_tracker
from peldrun.runtime.pricing_store import NANO_USD_PER_USD

logger = logging.getLogger(__name__)


async def record_chat_completion(
    *,
    response: Any,
    job_id: str,
    chat_id: str,
    project_id: str,
    provider_name: str,
    model_name: str,
    base_url: str,
    turns: List[Dict[str, Any]],
    started_at: float,
) -> Tuple[Any, float]:
    """
    Write the success ledger record and the per-turn session usage.

    Returns ``(usage, cost_usd)``. ``usage`` is the raw provider usage object
    (possibly None) because the caller forwards ``usage.to_dict()`` into the
    FINAL event and prints ``usage.total_tokens``.

    ``cost_usd`` is rounded to 6 decimals from the integer nano-USD ledger
    value -- the ledger is the single source of truth, never the reverse.

    NOTE: ``invocation_id`` contains a fresh uuid4 suffix, so it is NOT
    reproducible across calls. Parity tests must compare everything except
    that field.
    """
    usage = response.usage
    inv_id = f"inv_chat_{uuid.uuid4().hex[:10]}"
    turn_id = f"turn_{len(turns) + 1}"

    tracker_ctx = InvocationContext(
        provider=provider_name,
        model_requested=model_name,
        mode="chat",
        job_id=job_id,
        chat_id=chat_id,
        project_id=project_id,
        turn_id=turn_id,
        base_url=base_url,
    )
    record = await default_tracker.complete(
        response=response,
        context=tracker_ctx,
        started_at=started_at,
        invocation_id=inv_id,
    )
    cost_nano_usd = record.cost_nano_usd
    cost_usd = round(cost_nano_usd / NANO_USD_PER_USD, 6)

    if usage is not None:
        turn_usage_dict = {
            "turn_id": turn_id,
            "prompt_tokens": usage.input_tokens or 0,
            "completion_tokens": usage.output_tokens or 0,
            "total_tokens": usage.total_tokens or 0,
            "cost_usd": cost_usd,
            "cost_nano_usd": cost_nano_usd,
            "estimated": usage.estimated,
            "latency_ms": response.latency_ms,
        }
        project_manager.record_turn_usage(
            chat_id=chat_id,
            turn_id=turn_id,
            turn_usage=turn_usage_dict,
            project_id=project_id,
        )

    return (usage, cost_usd)


async def record_chat_cancellation(
    *,
    job_id: str,
    chat_id: str,
    project_id: str,
    provider_name: str,
    model_name: str,
    base_url: str,
    started_at: float,
) -> None:
    """
    Record a user cancellation in the ledger. Best-effort, never raises.

    NOTE: this context carries NO ``turn_id`` -- the turn never completed.
    Adding one would make cancelled turns indistinguishable from completed
    ones in per-turn aggregations.
    """
    try:
        await default_tracker.cancel(
            InvocationContext(
                provider=provider_name,
                model_requested=model_name,
                mode="chat",
                job_id=job_id,
                chat_id=chat_id,
                project_id=project_id,
                base_url=base_url,
            ),
            started_at=started_at,
        )
    except Exception as _cancel_rec_err:
        logger.debug(
            "Cancellation record skipped for %s: %s",
            job_id,
            _cancel_rec_err,
        )


async def record_chat_failure(
    *,
    error: BaseException,
    job_id: str,
    chat_id: str,
    project_id: str,
    provider_name: str,
    model_name: str,
    base_url: str,
    started_at: float,
) -> None:
    """Record a failed invocation in the ledger. Best-effort, never raises."""
    try:
        await default_tracker.fail(
            error=error,
            context=InvocationContext(
                provider=provider_name,
                model_requested=model_name,
                mode="chat",
                job_id=job_id,
                chat_id=chat_id,
                project_id=project_id,
                base_url=base_url,
            ),
            started_at=started_at,
        )
    except Exception as _fail_rec_err:
        logger.debug(
            "Failure record skipped for %s: %s",
            job_id,
            _fail_rec_err,
        )


def enrich_last_turn(
    chat_id: str,
    prompt: str,
    result_text: str,
    job_id: str,
) -> None:
    """
    Persist the FULL turn content into ``turns[]``. Best-effort, never raises.

    ``job_manager.complete_job`` writes session-level ``prompt``/``result``
    (LAST job only) and a ``turns[]`` entry carrying just
    ``{turn_id, timestamp, usage}``. Historical turns therefore had NO
    accessible content, and the extraction orchestrator's chat-mode fallback
    could only recover the last turn from the session level.

    This fills the canonical ``user`` / ``assistant`` fields on the LAST
    turn, making every turn self-contained for future extraction passes.
    The write goes through ``project_manager.save_chat_session`` -- no direct
    file manipulation -- and only GAINS fields, never removes any.
    """
    try:
        _current = project_manager.get_chat(chat_id) or {}
        _current_turns = _current.get("turns") or []
        if _current_turns:
            _last_idx = len(_current_turns) - 1
            _last_turn = _current_turns[_last_idx]
            if isinstance(_last_turn, dict):
                _needs_user = not _last_turn.get("user")
                _needs_assistant = not _last_turn.get("assistant")
                if _needs_user or _needs_assistant:
                    if _needs_user:
                        _last_turn["user"] = prompt
                    if _needs_assistant:
                        _last_turn["assistant"] = result_text
                    project_manager.save_chat_session(chat_id, _current)
                    logger.info(
                        "[BRIDGE DIRECT CHAT] Enriched turn %d "
                        "with user/assistant text for job %s "
                        "(needed user=%s, assistant=%s)",
                        _last_idx,
                        job_id,
                        _needs_user,
                        _needs_assistant,
                    )
    except Exception as _enrich_err:
        logger.debug(
            "[BRIDGE DIRECT CHAT] Turn enrichment skipped "
            "for job %s: %s",
            job_id,
            _enrich_err,
        )


__all__ = [
    "record_chat_completion",
    "record_chat_cancellation",
    "record_chat_failure",
    "enrich_last_turn",
]

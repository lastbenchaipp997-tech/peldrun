# backend/omweb/agent_bridge_parts/dispatcher/readiness_gate.py
"""
Local-provider readiness gate, shared by BOTH dispatch modes.

The identical 20-line probe/fail/emit/cleanup block existed twice in the
legacy dispatcher. It is now a single decision function.

CONTRACT
--------
``await ensure_local_model_ready(...)`` returns:

    True  -> proceed with the run.
    False -> the caller MUST ``return`` immediately. The job has already
             been marked failed, the ERROR SSE event has been dispatched
             and ``cleanup_job_state`` has been called.

The gate is a no-op (returns True) for any endpoint that is not a local
LM Studio instance, detected by the same heuristic as before:
``"1234" in base_url`` OR ``"lmstudio" in provider_name.lower()``.

WHY cleanup_job_state IS CALLED HERE
------------------------------------
Both original call sites ran this block BEFORE the try/finally that owns
cleanup, so the early-return path had to clean up explicitly. Keeping the
cleanup inside the gate preserves that exactly. The caller must NOT call
cleanup again on the False path.

PRESERVED ASYMMETRY: api_key
----------------------------
The two modes passed DIFFERENT defaults into the probe:

    agent -> ``active_llm.get("api_key", "")``   (empty string)
    chat  -> ``active_llm.get("api_key") or "EMPTY"``

``api_key`` is therefore a required parameter supplied by the caller.
Unifying the default would change the Authorization header sent to the
local server for one of the two modes.

ERROR MESSAGE CONTRACT
----------------------
The two synthetic exception texts ("Connection refused (Port 1234)" and
"failed to load model") are fed to ``format_smart_error``, which maps
them to user-facing guidance. They are string constants of that mapping
and must not be reworded.
"""
from __future__ import annotations

import logging

from omweb.job_manager import job_manager
from omweb.sse_events import SSEEvent, SSEEventType, dispatch_event

from ..errors import format_smart_error
from ..lmstudio import check_lmstudio_model_readiness
from ..state import cleanup_job_state

logger = logging.getLogger(__name__)


async def ensure_local_model_ready(
    job_id: str,
    base_url: str,
    model_name: str,
    provider_name: str,
    api_key: str,
) -> bool:
    """
    Probe a local LM Studio endpoint and fail the job if it is not usable.

    Two failure shapes are distinguished:
      * ``unreachable``            -- server not listening at all.
      * ``found`` and not loaded   -- server up, model not loaded.

    Any other probe outcome (including ``found=False``, i.e. the model is
    absent from the catalog) is treated as "proceed" -- exactly as the
    original did. The provider itself will produce the authoritative
    error in that case.
    """
    if not ("1234" in base_url or "lmstudio" in provider_name.lower()):
        return True

    readiness = await check_lmstudio_model_readiness(
        base_url, model_name, api_key
    )

    if readiness.get("unreachable"):
        err_msg = format_smart_error(
            Exception("Connection refused (Port 1234)"),
            model_name,
            provider_name,
        )
        job_manager.fail_job(job_id, err_msg)
        await dispatch_event(
            job_id,
            SSEEvent(
                type=SSEEventType.ERROR,
                step=1,
                data={"message": err_msg, "model": model_name},
            ),
        )
        cleanup_job_state(job_id)
        return False

    if readiness.get("found") and not readiness.get("is_loaded"):
        err_msg = format_smart_error(
            Exception("failed to load model"),
            model_name,
            provider_name,
        )
        job_manager.fail_job(job_id, err_msg)
        await dispatch_event(
            job_id,
            SSEEvent(
                type=SSEEventType.ERROR,
                step=1,
                data={"message": err_msg, "model": model_name},
            ),
        )
        cleanup_job_state(job_id)
        return False

    return True


__all__ = ["ensure_local_model_ready"]

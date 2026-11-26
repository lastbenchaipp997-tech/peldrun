# backend/omweb/agent_bridge_parts/dispatcher/agent_post_run.py
"""
Agent-mode post-run state verification and terminal-signal synthesis.

Extracted verbatim from the [Phase H] block of ``run_instrumented``.

THE BUG THIS BLOCK EXISTS TO FIX
--------------------------------
PeldrunEngine catches LLM/provider errors INSIDE ``executor.execute()``: it
logs, calls ``job_manager.fail_job()``, and RETURNS NORMALLY without
re-raising. Before this verification existed the dispatcher therefore:

  1. saw ``await engine.run(context)`` return cleanly,
  2. signalled ``complete_run`` to the monitor (wrong),
  3. never dispatched an ERROR event,
  4. left ``streaming.py`` waiting forever for a terminal event (only ping
     heartbeats), so the SSE stream never closed,
  5. left the frontend stuck in "running" with no error at all.

The fix inspects the ACTUAL PERSISTED job state after the engine returns and
synthesizes the missing terminal event, so the frontend always receives
exactly one terminal signal.

IMPORT PATH IS LOAD-BEARING
---------------------------
``ACTIVE_JOB_EVENTS`` lives in ``omweb/routers/run_routes/state.py``, NOT in
``omweb/agent_bridge_parts/state.py``. The two modules share the basename
"state" but are different files. A previous ``from .state import ...``
resolved to the wrong one and raised ImportError, which the outer handler
turned into an ERROR event carrying the ImportError text instead of the real
provider error. The import stays LAZY and UNGUARDED here on purpose: an
ImportError must propagate to the dispatch error handler exactly as before.

NO FINAL SYNTHESIS (deliberate)
-------------------------------
On the success path this block does NOT dispatch a FINAL event. PeldrunEngine
always calls ``complete_job`` AND dispatches its own FINAL before returning;
synthesizing another one produced duplicates because the engine's event bus
and ACTIVE_JOB_EVENTS were out of sync. If the engine crashes before sending
FINAL, the dispatch error handler covers it.

RETURN CONTRACT
---------------
Returns True ONLY on the success branch. The caller runs the After-Turn
memory hook exclusively in that case -- preserving the original nesting,
where the hook lived inside the ``else`` branch.
"""
from __future__ import annotations

import logging

from omweb.job_manager import job_manager
from omweb.sse_events import SSEEvent, SSEEventType, dispatch_event

from ..errors import format_smart_error
from .monitor_hooks import (
    safe_monitor_cancel_run,
    safe_monitor_complete_run,
    safe_monitor_fail_run,
)
from .session_log import append_session_log

logger = logging.getLogger(__name__)

# Event types that already constitute a terminal signal for the frontend.
_TERMINAL_TYPES = {"final", "error", "cancelled", "done"}


async def verify_and_finalize_agent_run(
    job_id: str,
    chat_id: str,
    project_id: str,
    model_name: str,
    provider_name: str,
) -> bool:
    """
    Reconcile monitor state, session log and SSE terminal signal with the
    persisted job status. Returns True when the run completed successfully.
    """
    # Lazy + unguarded on purpose -- see the module docstring.
    from omweb.routers.run_routes.state import (
        ACTIVE_JOB_EVENTS as _ACTIVE_JOB_EVENTS,
    )

    final_job = job_manager.get_job(job_id)
    final_status = (final_job.status if final_job else "").lower()
    final_error = (final_job.error if final_job else None) or ""

    _events = _ACTIVE_JOB_EVENTS.get(job_id) or []
    _already_terminal = any(
        str(ev.get("type", "")).lower() in _TERMINAL_TYPES
        for ev in _events
    )

    if final_status == "failed":
        err_msg = format_smart_error(
            Exception(final_error or "Execution failed."),
            model_name,
            provider_name,
        )
        safe_monitor_fail_run(job_id, error_message=err_msg)
        append_session_log(
            chat_id, project_id, "ERROR",
            final_error or "Execution failed.",
        )
        if not _already_terminal:
            logger.warning(
                "[BRIDGE] Engine returned with status=failed for job "
                "%s but did NOT dispatch a terminal SSE event. "
                "Synthesizing ERROR: %s",
                job_id,
                final_error or "(no message)",
            )
            await dispatch_event(
                job_id,
                SSEEvent(
                    type=SSEEventType.ERROR,
                    step=1,
                    data={
                        "message": err_msg,
                        "model": model_name,
                        "provider": provider_name,
                    },
                ),
            )
        return False

    if final_status == "cancelled":
        safe_monitor_cancel_run(job_id)
        append_session_log(
            chat_id, project_id, "SYSTEM",
            "Execution cancelled.",
        )
        if not _already_terminal:
            logger.warning(
                "[BRIDGE] Engine returned with status=cancelled for "
                "job %s but did NOT dispatch a terminal SSE event. "
                "Synthesizing CANCELLED.",
                job_id,
            )
            await dispatch_event(
                job_id,
                SSEEvent(
                    type=SSEEventType.CANCELLED,
                    step=1,
                    data={"message": "Execution cancelled."},
                ),
            )
        return False

    # Success path: monitor + session log only. NO FINAL synthesis.
    safe_monitor_complete_run(job_id)
    append_session_log(
        chat_id, project_id, "FINAL",
        "Execution completed successfully.",
    )
    return True


__all__ = ["verify_and_finalize_agent_run"]

# backend/omweb/agent_bridge_parts/dispatcher/monitor_hooks.py
"""
ResourceMonitor signaling for the PELDRUN Universal Agent Bridge.

Extracted from ``dispatcher.py``. Behavior preserved verbatim.

CONTRACT: THESE FUNCTIONS MUST NEVER RAISE
------------------------------------------
Every function here is called from a terminal path of a run -- including
from inside ``except`` and ``finally`` blocks. If one of them raised, it
would replace the real provider error with a monitoring error, or abort
cleanup and leave the job stuck in "running" forever.

Each wrapper therefore:
  * imports the service LAZILY (the monitor service pulls in a heavy
    dependency graph and may be unavailable in unit tests),
  * swallows EVERY exception,
  * logs at DEBUG only -- a monitoring failure is not a run failure and
    must not pollute the user-visible error channel.

Do not "improve" these into raising helpers or raise the log level
without auditing every call site in the dispatch modules.
"""
from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)


def safe_monitor_start_run(job_id: str) -> None:
    """Signal run start to ResourceMonitor. Best-effort, never raises."""
    try:
        from omweb.services.resource_monitor_service import get_resource_monitor_service
        get_resource_monitor_service().start_run(job_id)
    except Exception as exc:
        logger.debug("Failed to signal start_run to ResourceMonitor for %s: %s", job_id, exc)


def safe_monitor_complete_run(job_id: str) -> None:
    """Signal successful run completion to ResourceMonitor. Never raises."""
    try:
        from omweb.services.resource_monitor_service import get_resource_monitor_service
        get_resource_monitor_service().complete_run(job_id)
    except Exception as exc:
        logger.debug("Failed to signal complete_run to ResourceMonitor for %s: %s", job_id, exc)


def safe_monitor_fail_run(job_id: str, error_message: Optional[str] = None) -> None:
    """
    Signal run failure to ResourceMonitor. Never raises.

    ``error_message`` is forwarded as a KEYWORD argument, matching the
    service signature. Passing it positionally would break any service
    implementation that declares it keyword-only.
    """
    try:
        from omweb.services.resource_monitor_service import get_resource_monitor_service
        get_resource_monitor_service().fail_run(job_id, error_message=error_message)
    except Exception as exc:
        logger.debug("Failed to signal fail_run to ResourceMonitor for %s: %s", job_id, exc)


def safe_monitor_cancel_run(job_id: str) -> None:
    """Signal user cancellation to ResourceMonitor. Never raises."""
    try:
        from omweb.services.resource_monitor_service import get_resource_monitor_service
        get_resource_monitor_service().cancel_run(job_id)
    except Exception as exc:
        logger.debug("Failed to signal cancel_run to ResourceMonitor for %s: %s", job_id, exc)


__all__ = [
    "safe_monitor_start_run",
    "safe_monitor_complete_run",
    "safe_monitor_fail_run",
    "safe_monitor_cancel_run",
]

# backend/omweb/agent_bridge_parts/dispatcher/agent_dispatch.py
"""
AGENT MODE entry point for the PELDRUN Universal Agent Bridge.

This is a THIN ORCHESTRATOR. Every decision lives in a sibling module that
was extracted and parity-verified against the legacy dispatcher before this
file was written. Nothing here computes anything new.

SEQUENCE (order is behavior -- do not reorder)
----------------------------------------------
  register task
  agent_setup.resolve_agent_run        authority + manifest + payload pop
  llm_runtime_config.merge_active_llm
  llm_runtime_config.apply_generative_ui_fallback
  llm_runtime_config.normalize_reasoning_effort       AGENT ONLY
  llm_runtime_config.apply_runtime_timeouts
  llm_runtime_config.apply_vault_base_url_override    AGENT ONLY
  llm_runtime_config.resolve_display_target
  readiness_gate.ensure_local_model_ready
  STATUS / RUN_ACCEPTED event
  monitor start
  workspace.resolve_project_workspace + log
  session logs (SYSTEM init, STEP task)
  llm_runtime_config.apply_model_limits
  reference_injection.inject_for_agent               emits REFS_RESOLVED
  agent_routing.apply_agent_provider_routing         AGENT ONLY shape
  memory_bridge.retrieve_for_agent
  EngineRunContext -> engine.run
  agent_post_run.verify_and_finalize_agent_run
  memory_bridge.notify_after_turn_agent              SUCCESS BRANCH ONLY
  finally: cleanup_job_state

TWO ABORT CONVENTIONS IN PLAY
-----------------------------
``setup.aborted`` and a False from ``ensure_local_model_ready`` BOTH mean
"return now, cleanup already ran" -- those paths sit outside the try/finally.
The try/finally below owns cleanup for everything after it. Never add a
cleanup call to an early return inside the try block.

PRESERVED LATENT SHARP EDGE
---------------------------
``chat_id`` / ``project_id`` are bound BEFORE the try, so the cancel/error
handlers can always log. That is deliberate and matches the original. (The
chat orchestrator has the opposite arrangement -- see its docstring.)

The CancelledError handler does NOT re-raise and does NOT touch job_manager:
cancellation state is owned by the cancel endpoint. Re-raising here would
surface a spurious task exception in the run supervisor.
"""
from __future__ import annotations

import asyncio
import logging
import traceback
from typing import Any, Dict, Optional

from omweb.engines.base import EngineRunContext
from omweb.job_manager import job_manager
from omweb.project_manager import project_manager
from omweb.sse_events import SSEEvent, SSEEventType, dispatch_event

from ..errors import format_smart_error
from ..state import cleanup_job_state, register_job_task
from .agent_post_run import verify_and_finalize_agent_run
from .agent_routing import apply_agent_provider_routing
from .agent_setup import resolve_agent_run
from .llm_runtime_config import (
    apply_generative_ui_fallback,
    apply_model_limits,
    apply_runtime_timeouts,
    apply_vault_base_url_override,
    merge_active_llm,
    normalize_reasoning_effort,
    resolve_display_target,
)
from .memory_bridge import notify_after_turn_agent, retrieve_for_agent
from .monitor_hooks import (
    safe_monitor_cancel_run,
    safe_monitor_fail_run,
    safe_monitor_start_run,
)
from .readiness_gate import ensure_local_model_ready
from .reference_injection import inject_for_agent
from .session_log import append_session_log
from .workspace import log_workspace_resolution, resolve_project_workspace

logger = logging.getLogger(__name__)

_MODE_PREFIX = "[BRIDGE]"


async def run_instrumented(
    job_id: str,
    prompt: str,
    *args: Any,
    agent_id: Any = None,
    llm_override: Optional[Dict[str, Any]] = None,
    **kwargs: Any,
) -> None:
    """
    Dispatch an agent job using PELDRUN Core as the single execution authority.

    Signature is byte-compatible with the legacy entry point, including the
    positional ``*args`` back-fill that ``agent_setup`` normalizes.
    """
    current_task = asyncio.current_task()
    if current_task is not None:
        register_job_task(job_id, current_task)

    setup = await resolve_agent_run(
        job_id,
        args=args,
        agent_id=agent_id,
        llm_override=llm_override,
        kwargs=kwargs,
    )
    if setup.aborted:
        # Failure, ERROR dispatch and cleanup already happened.
        return

    agent_id = setup.agent_id
    llm_override = setup.llm_override
    target_engine_str = setup.target_engine
    engine = setup.engine
    manifest = setup.manifest

    active_llm = merge_active_llm(llm_override)
    apply_generative_ui_fallback(active_llm, job_id)
    normalize_reasoning_effort(active_llm)
    apply_runtime_timeouts(active_llm, llm_override, job_id)
    apply_vault_base_url_override(active_llm, job_id)

    provider_name, model_name, base_url = resolve_display_target(active_llm)
    print(
        f"[BRIDGE] Target LLM: [{provider_name}] Model: '{model_name}' "
        f"| URL: '{base_url}' "
        f"| Reasoning: '{active_llm.get('reasoning_effort')}'"
    )

    # Agent mode passes "" (not "EMPTY") as the api_key default.
    if not await ensure_local_model_ready(
        job_id,
        base_url,
        model_name,
        provider_name,
        active_llm.get("api_key", ""),
    ):
        return

    status_event_type = (
        getattr(SSEEventType, "STATUS", None)
        or getattr(SSEEventType, "RUN_ACCEPTED", None)
    )
    if status_event_type is not None:
        await dispatch_event(
            job_id,
            SSEEvent(
                type=status_event_type,
                step=0,
                data={
                    "status": "accepted",
                    "model": model_name,
                    "provider": provider_name,
                    "mode": "agent",
                    "engine": target_engine_str,
                },
            ),
        )

    safe_monitor_start_run(job_id)

    chat = project_manager.get_chat(job_id) or {}
    chat_id = chat.get("id", f"chat_{job_id}")
    project_id = chat.get("project_id", "default_project")

    project_dir, ws_type = resolve_project_workspace(chat_id, project_id)
    log_workspace_resolution(
        job_id, project_dir, project_id, ws_type,
        mode_prefix=_MODE_PREFIX,
    )

    append_session_log(
        chat_id, project_id, "SYSTEM",
        f"Execution initialized. Engine: '{target_engine_str}', "
        f"Agent: '{agent_id}'",
    )
    append_session_log(
        chat_id, project_id, "STEP", f"Task started: {prompt[:120]}"
    )

    apply_model_limits(active_llm, model_name, log_prefix=_MODE_PREFIX)

    final_prompt, merged_refs = await inject_for_agent(
        job_id, prompt, setup.context_refs, project_dir, model_name
    )

    apply_agent_provider_routing(active_llm, job_id)

    # Query is the ORIGINAL prompt, never final_prompt.
    memory_context = await retrieve_for_agent(
        job_id, prompt, chat_id, project_id
    )

    context = EngineRunContext(
        job_id=job_id,
        prompt=final_prompt,
        agent_id=agent_id,
        active_llm=active_llm,
        model_name=model_name,
        provider_name=provider_name,
        project_dir=project_dir,
        chat_id=chat_id,
        manifest=manifest,
        context_refs=merged_refs,
        attachments=setup.attachments,
        invoked_skills=setup.invoked_skills,
        memory_context=memory_context,
    )

    try:
        await engine.run(context)
        completed_ok = await verify_and_finalize_agent_run(
            job_id, chat_id, project_id, model_name, provider_name
        )
        if completed_ok:
            # Success branch only -- preserves the original nesting inside
            # the else-branch of the post-run verification.
            await notify_after_turn_agent(job_id, chat_id, project_id)
    except asyncio.CancelledError:
        print(f"[BRIDGE] Job was cancelled/aborted: {job_id}")
        safe_monitor_cancel_run(job_id)
        append_session_log(
            chat_id, project_id, "SYSTEM", "Execution cancelled by user."
        )
    except Exception as err:
        tb = traceback.format_exc()
        print(f"[BRIDGE ERROR] {err}\n{tb}")
        err_msg = format_smart_error(err, model_name, provider_name)
        safe_monitor_fail_run(job_id, error_message=err_msg)
        job_manager.fail_job(job_id, err_msg)
        append_session_log(chat_id, project_id, "ERROR", err_msg)
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
    finally:
        cleanup_job_state(job_id)


__all__ = ["run_instrumented"]

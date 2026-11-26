# backend/omweb/agent_bridge_parts/dispatcher/agent_setup.py
"""
Agent-mode run setup: argument normalization, authority resolution, and
the extraction of non-LLM payload fields.

Extracted verbatim from the head of ``run_instrumented``. AGENT-ONLY.

ABORT CONTRACT (opposite of chat web search -- read carefully)
--------------------------------------------------------------
Every failure path here runs BEFORE the dispatch ``try/finally`` that owns
cleanup. The original therefore had to call ``cleanup_job_state`` explicitly
on each early return. This module keeps that: when ``aborted=True`` the job
is already failed, the ERROR event is dispatched, and cleanup HAS run.

    if setup.aborted:
        return          # do NOT call cleanup_job_state again

Compare ``chat_web_search.WebSearchOutcome``, whose abort happens INSIDE the
caller's try/finally and must NOT clean up itself.

RESOLUTION ORDER (unchanged)
----------------------------
  1. Positional ``*args`` back-fill (dict -> llm_override, str -> agent_id).
     Legacy callers passed these positionally; the loop keeps them working.
  2. ``llm_override["agent_id"]``.
  3. ``kwargs["agent_id"]``, else the literal ``"peldrun"``.
  4. Engine id from ``kwargs["engine"]`` or ``llm_override["engine"]``,
     validated by ``engine_policy`` (rejects the removed legacy engines).
  5. ``engine_registry.get`` -- the single execution authority.
  6. ``agent_registry.get_effective_agent`` -- NOT ``get_agent``: the
     effective variant merges user-saved Store settings (max_steps,
     temperature, ...) into the manifest before the runtime sees it, while
     preserving identity fields and the ``status`` flag checked next.
  7. ``status == "disabled"`` -> abort.

PAYLOAD POPPING (security-relevant)
-----------------------------------
``context_refs``, ``attachments`` and ``invoked_skills`` are POPPED from a
shallow copy of ``llm_override`` before it is merged into ``active_llm``.
They must never reach the provider configuration payload: an unrecognized
field is either silently ignored (best case) or triggers a provider-specific
error (worst case). The caller's dict is never mutated.

``invoked_skills`` is sanitized to non-empty stripped strings, and an empty
result collapses to None (not ``[]``) -- the engine distinguishes "no skills
invoked" from "empty list".

SKILL INVOCATION CHANNEL -- WHY THERE IS NO PROMPT PARSING
----------------------------------------------------------
``invoked_skills`` comes EXCLUSIVELY from the composer's ``/`` typeahead:
the frontend strips the token and sends the id explicitly. This module
deliberately does NOT scan the prompt for ``/skill_id``:
  (a) the token is already stripped, so it is not reliably present;
  (b) a prompt may carry a ``[Context: In previous turn, user asked:
      '/code_review ...']`` prefix -- scanning would re-inject that skill on
      every later turn, an infinite "sticky invocation" bug.
A caller bypassing the composer MUST pass ``invoked_skills`` explicitly.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from omweb.agents.registry import AgentNotFoundError, agent_registry
from omweb.engines import engine_registry
from omweb.engines.registry import EngineNotFoundError
from omweb.job_manager import job_manager
from omweb.sse_events import SSEEvent, SSEEventType, dispatch_event

from ..state import cleanup_job_state, job_scoped_artifacts
from .engine_policy import validate_requested_engine

logger = logging.getLogger(__name__)


@dataclass
class AgentSetup:
    """
    Everything the setup phase resolved for the run.

    ``aborted=True`` means the caller must return immediately; failure,
    ERROR dispatch and cleanup have already happened.
    """

    agent_id: str = "peldrun"
    llm_override: Optional[Dict[str, Any]] = None
    target_engine: str = ""
    engine: Any = None
    manifest: Optional[Dict[str, Any]] = None
    context_refs: Optional[List[Dict[str, Any]]] = None
    attachments: Optional[List[Dict[str, Any]]] = None
    invoked_skills: Optional[List[str]] = None
    aborted: bool = False


def normalize_agent_arguments(
    args: Tuple[Any, ...],
    agent_id: Any,
    llm_override: Optional[Dict[str, Any]],
    kwargs: Dict[str, Any],
) -> Tuple[str, Optional[Dict[str, Any]]]:
    """
    Resolve ``(agent_id, llm_override)`` from the mixed calling conventions.

    Pure: no I/O, no logging, no mutation of the inputs. Kept separate so
    the legacy positional-argument compatibility can be unit-tested
    without any registry or SSE machinery.
    """
    for arg in args:
        if isinstance(arg, dict) and llm_override is None:
            llm_override = arg
        elif isinstance(arg, str) and agent_id is None:
            agent_id = arg
    if not agent_id and isinstance(llm_override, dict):
        agent_id = llm_override.get("agent_id")
    if not agent_id or not isinstance(agent_id, str):
        agent_id = kwargs.get("agent_id") or "peldrun"
    return (agent_id, llm_override)


def pop_run_payload(
    job_id: str,
    llm_override: Optional[Dict[str, Any]],
) -> Tuple[
    Optional[Dict[str, Any]],
    Optional[List[Dict[str, Any]]],
    Optional[List[Dict[str, Any]]],
    Optional[List[str]],
]:
    """
    Shallow-copy ``llm_override`` and pop the three non-LLM payload fields.

    Returns ``(llm_override, context_refs, attachments, invoked_skills)``.
    A non-dict input is returned untouched with all three fields None.
    """
    context_refs: Optional[List[Dict[str, Any]]] = None
    attachments: Optional[List[Dict[str, Any]]] = None
    invoked_skills: Optional[List[str]] = None

    if isinstance(llm_override, dict):
        llm_override = dict(llm_override)
        context_refs = llm_override.pop("context_refs", None)
        attachments = llm_override.pop("attachments", None)
        invoked_skills_raw = llm_override.pop("invoked_skills", None)
        if isinstance(invoked_skills_raw, list):
            invoked_skills = [
                str(s).strip()
                for s in invoked_skills_raw
                if isinstance(s, str) and s.strip()
            ] or None
        if context_refs:
            print(
                f"[BRIDGE] Resolved {len(context_refs)} context reference(s) "
                f"for job {job_id}"
            )
        if attachments:
            print(
                f"[BRIDGE] Resolved {len(attachments)} multimodal attachment(s) "
                f"for job {job_id}"
            )
        if invoked_skills:
            print(
                f"[BRIDGE] Resolved {len(invoked_skills)} invoked skill(s) "
                f"for job {job_id}: {invoked_skills}"
            )

    return (llm_override, context_refs, attachments, invoked_skills)


async def _fail_and_cleanup(
    job_id: str,
    err_msg: str,
    *,
    step: int,
    data: Dict[str, Any],
    echo: bool,
) -> None:
    """
    The single early-return shape used by every setup failure path.

    Order is load-bearing and identical to the four inlined copies:
    optional stdout echo -> fail_job -> ERROR dispatch -> cleanup.

    ``echo`` exists because the "agent disabled" path historically did NOT
    print to stdout while the other three did. Preserved verbatim.
    """
    if echo:
        print(f"[BRIDGE ERROR] {err_msg}")
    job_manager.fail_job(job_id, err_msg)
    await dispatch_event(
        job_id,
        SSEEvent(type=SSEEventType.ERROR, step=step, data=data),
    )
    cleanup_job_state(job_id)


async def resolve_agent_run(
    job_id: str,
    *,
    args: Tuple[Any, ...] = (),
    agent_id: Any = None,
    llm_override: Optional[Dict[str, Any]] = None,
    kwargs: Optional[Dict[str, Any]] = None,
) -> AgentSetup:
    """
    Run the full agent setup phase. See the module docstring for the abort
    contract and the resolution order.
    """
    kwargs = kwargs or {}
    agent_id, llm_override = normalize_agent_arguments(
        args, agent_id, llm_override, kwargs
    )

    explicit_engine = kwargs.get("engine") or (
        llm_override.get("engine") if isinstance(llm_override, dict) else None
    )

    try:
        target_engine_str = validate_requested_engine(explicit_engine)
    except ValueError as val_err:
        err_msg = str(val_err)
        await _fail_and_cleanup(
            job_id,
            err_msg,
            step=0,
            data={"message": err_msg, "engine": str(explicit_engine)},
            echo=True,
        )
        return AgentSetup(aborted=True)

    print(
        f"\n[BRIDGE] Initializing job {job_id} using authoritative "
        f"engine: '{target_engine_str}'"
    )
    job_scoped_artifacts.setdefault(job_id, [])

    try:
        engine = engine_registry.get(target_engine_str)
    except EngineNotFoundError as eng_err:
        err_msg = str(eng_err)
        await _fail_and_cleanup(
            job_id,
            err_msg,
            step=1,
            data={"message": err_msg, "engine": target_engine_str},
            echo=True,
        )
        return AgentSetup(aborted=True)

    # get_effective_agent (NOT get_agent) merges user-saved Store settings
    # into the manifest. The merge only honours keys declared in
    # settings.schema.properties, so identity fields and ``status`` survive.
    try:
        manifest = agent_registry.get_effective_agent(agent_id)
    except AgentNotFoundError as agent_err:
        err_msg = str(agent_err)
        await _fail_and_cleanup(
            job_id,
            err_msg,
            step=0,
            data={"message": err_msg},
            echo=True,
        )
        return AgentSetup(aborted=True)

    if manifest.get("status") == "disabled":
        err_msg = (
            f"Agent '{manifest.get('name', agent_id)}' is currently disabled "
            f"in Capability Store. Enable it first."
        )
        await _fail_and_cleanup(
            job_id,
            err_msg,
            step=0,
            data={"message": err_msg},
            echo=False,
        )
        return AgentSetup(aborted=True)

    llm_override, context_refs, attachments, invoked_skills = pop_run_payload(
        job_id, llm_override
    )

    return AgentSetup(
        agent_id=agent_id,
        llm_override=llm_override,
        target_engine=target_engine_str,
        engine=engine,
        manifest=manifest,
        context_refs=context_refs,
        attachments=attachments,
        invoked_skills=invoked_skills,
        aborted=False,
    )


__all__ = [
    "AgentSetup",
    "normalize_agent_arguments",
    "pop_run_payload",
    "resolve_agent_run",
]

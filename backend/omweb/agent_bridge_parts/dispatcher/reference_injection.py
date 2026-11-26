# backend/omweb/agent_bridge_parts/dispatcher/reference_injection.py
"""
Workspace file-reference resolution and prompt injection for BOTH modes.

Extracted from the inlined blocks in ``run_instrumented`` and
``run_direct_chat``. The DEDUPE CORE is now shared; the two mode-specific
wrappers stay separate because their behavior genuinely differs.

PRESERVED ASYMMETRIES (do not "unify" these)
--------------------------------------------
1. TRIGGER CONDITION
   Agent : resolution ALWAYS runs, even with ``context_refs=None``.
           A manually typed ``@file`` token therefore works on its own.
   Chat  : the whole block is skipped unless ``context_refs`` is truthy.
           A manually typed ``@file`` with no composer ref does NOTHING.
   This is a real pre-existing gap, not a refactor artifact. It is
   reproduced faithfully by ``inject_for_chat``'s early return.

2. FAILURE ISOLATION
   Agent : no try/except around resolution -- an exception propagates to
           the dispatch error handler and fails the run.
   Chat  : fully guarded; on failure the ORIGINAL prompt is used and a
           WARNING is logged. The chat still runs.

3. TRANSPARENCY EVENT
   Agent : emits ``REFS_RESOLVED`` (best-effort) so the timeline can show
           a "Referenced files" chip.
   Chat  : emits nothing; chat mode has no timeline.

4. INJECT CALL SHAPE
   Agent calls ``inject_referenced_files`` unconditionally and then
   overwrites the result with ``cleaned_prompt`` when nothing merged.
   Chat calls it only when something merged. The observable outcome is
   identical (the helper is a no-op on an empty list) but both shapes are
   kept verbatim so a future change to the helper cannot diverge them.

IMPORT DEPTH
------------
``mention_resolver`` lives in ``agent_bridge_parts``, one level ABOVE this
package, so it is imported with TWO dots.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from omweb.sse_events import SSEEvent, SSEEventType, dispatch_event

from ..mention_resolver import (
    inject_referenced_files,
    resolve_context_refs,
    resolve_inline_mentions,
)

logger = logging.getLogger(__name__)


def _merge_by_rel_path(
    structured_refs: List[Dict[str, Any]],
    inline_refs: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Concatenate structured + inline refs, deduped by canonical ``relPath``.

    Structured refs win on collision because they come first. Entries
    with a falsy ``relPath`` are dropped entirely -- an unresolved ref
    must never reach the injector.
    """
    merged: List[Dict[str, Any]] = []
    seen: set = set()
    for r in structured_refs + inline_refs:
        rel = r.get("relPath", "")
        if rel and rel not in seen:
            seen.add(rel)
            merged.append(r)
    return merged


def resolve_and_merge(
    prompt: str,
    context_refs: Optional[List[Dict[str, Any]]],
    workspace_dir: Path,
) -> Tuple[str, List[Dict[str, Any]]]:
    """
    Resolve both ref sources against the workspace and dedupe them.

    Returns ``(cleaned_prompt, merged_refs)``. ``cleaned_prompt`` is the
    prompt after the inline resolver's ``@``-token rewriting, which must
    be preserved even when no ref resolved successfully.
    """
    structured_refs = resolve_context_refs(context_refs, workspace_dir)
    cleaned_prompt, inline_refs = resolve_inline_mentions(prompt, workspace_dir)
    return (cleaned_prompt, _merge_by_rel_path(structured_refs, inline_refs))


async def inject_for_agent(
    job_id: str,
    prompt: str,
    context_refs: Optional[List[Dict[str, Any]]],
    workspace_dir: Path,
    model_name: str,
) -> Tuple[str, List[Dict[str, Any]]]:
    """
    Agent-mode injection. Returns ``(final_prompt, merged_refs)``.

    ``merged_refs`` is returned because it is forwarded into
    ``EngineRunContext.context_refs`` -- the engine needs the list, not
    just the augmented prompt.

    Raises whatever the resolver/injector raises (see asymmetry 2).
    """
    cleaned_prompt, merged_refs = resolve_and_merge(
        prompt, context_refs, workspace_dir
    )
    final_prompt = inject_referenced_files(
        cleaned_prompt,
        merged_refs,
        workspace_dir,
    )
    if merged_refs:
        print(
            f"[BRIDGE] Injected {len(merged_refs)} file reference(s) "
            f"into the prompt for job {job_id}"
        )
        # Best-effort transparency event. A dispatch failure must never
        # break the run.
        try:
            await dispatch_event(
                job_id,
                SSEEvent(
                    type=SSEEventType.REFS_RESOLVED,
                    step=0,
                    data={
                        "refs": merged_refs,
                        "count": len(merged_refs),
                        "model": model_name,
                    },
                ),
            )
        except Exception as refs_emit_err:
            logger.debug(
                "[BRIDGE] Could not emit refs_resolved event for job %s: %s",
                job_id,
                refs_emit_err,
            )
    else:
        # Preserve any @-rewrite produced by the inline resolver.
        final_prompt = cleaned_prompt
    return (final_prompt, merged_refs)


def inject_for_chat(
    job_id: str,
    prompt: str,
    context_refs: Optional[List[Dict[str, Any]]],
    workspace_dir: Path,
) -> str:
    """
    Chat-mode injection. Returns the (possibly augmented) prompt.

    Synchronous: chat mode emits no refs event.

    The early return reproduces asymmetry 1 EXACTLY -- with no composer
    refs, inline ``@file`` tokens are not resolved in chat mode. Do not
    remove the guard as a "bug fix" inside this refactor; it changes
    which prompts reach the model and must be a separate decision.
    """
    if not context_refs:
        return prompt
    try:
        cleaned_prompt, merged = resolve_and_merge(
            prompt, context_refs, workspace_dir
        )
        if merged:
            augmented = inject_referenced_files(
                cleaned_prompt, merged, workspace_dir
            )
            print(
                f"[BRIDGE DIRECT CHAT] Injected "
                f"{len(merged)} file reference(s) into the "
                f"prompt for job {job_id}"
            )
            return augmented
        # Nothing resolved: keep the inline-cleaned prompt (it may still
        # contain @-marker rewrites) and tell the user why.
        print(
            f"[BRIDGE DIRECT CHAT] Context refs present "
            f"but none resolved for job {job_id} — model "
            f"will see only the prompt text."
        )
        return cleaned_prompt
    except Exception as _refs_err:
        logger.warning(
            "[BRIDGE DIRECT CHAT] Context ref injection failed "
            "for job %s: %s",
            job_id,
            _refs_err,
        )
        return prompt


__all__ = [
    "resolve_and_merge",
    "inject_for_agent",
    "inject_for_chat",
]

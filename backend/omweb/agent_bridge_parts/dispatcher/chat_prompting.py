# backend/omweb/agent_bridge_parts/dispatcher/chat_prompting.py
"""
Chat-mode prompt construction for the PELDRUN Universal Agent Bridge.

Extracted from ``dispatcher.py``. Behavior preserved verbatim.

This module owns the CHAT persona contract only. Agent mode receives its
system prompt from the agent manifest, not from here -- keeping the two
modes' prompting concerns in separate files is the point of the split.

DEPENDENCIES
------------
Only ``.model_resolution`` (a sibling pure leaf). No ``omweb`` imports,
no I/O, no state. The whole module is deterministically unit-testable.

PROMPT STRINGS ARE FROZEN
-------------------------
The four returned strings are reproduced BYTE-FOR-BYTE from the original,
including their original (occasionally awkward) phrasing. A system prompt
is model-visible behavior: rewording it changes model output. Do not
"fix the grammar" here -- that is a product decision, not a refactor.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from .model_resolution import is_reasoning_model

logger = logging.getLogger(__name__)


def resolve_chat_system_prompt(
    model_name: str,
    reasoning_effort: str,
    active_llm: Optional[Dict[str, Any]] = None,
    generative_ui: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Resolve chat system instructions following reasoning specifications.

    When Generative UI is enabled, the output-format directive is relaxed
    so the downstream OpenUI Lang directive (injected at Tier 1C of the
    context builder) is not contradicted by a conflicting 'Respond using
    Markdown' instruction. When Generative UI is disabled, the original
    Markdown directive is preserved.

    [FIX-SYSTEM-PROMPT-ALWAYS-PRESENT] This function MUST ALWAYS return a
    non-empty string. The previous implementation returned ``None`` when
    a reasoning-capable model ran with ``reasoning_effort`` disabled
    ("none", "off", "0"). Because ``reasoning_effort`` defaults to "none"
    for every model the user has not explicitly configured, the ``None``
    branch fired for the entire class of reasoning-capable models whose
    reasoning was either unset or explicitly turned off. The downstream
    chat pipeline (``build_optimized_chat_messages``) then emitted ZERO
    system messages, leaving the model with no persona directive at all.

    Chat-mode semantics are unambiguous: a reasoner running with
    reasoning disabled behaves exactly like a regular chat model at the
    provider level (no reasoning trace is produced). It therefore
    deserves the SAME conversational prompt as a non-reasoning model.
    Only when reasoning is actually ACTIVE do we prefer the concise
    variant.

    The ``generative_ui`` dict is consulted inside BOTH variants so that
    the GenUI path suppresses the "Respond using Markdown" clause (which
    would otherwise contradict the OpenUI Lang directive injected by the
    context builder at Tier 1C).
    """
    is_reasoner = is_reasoning_model(model_name, active_llm=active_llm)
    norm_effort = (reasoning_effort or "none").lower().strip()
    genui_enabled = bool(generative_ui and generative_ui.get("enabled"))

    # "Reasoning is actually active" -- the ONLY condition that justifies
    # the concise variant. A reasoner with effort="none"/"off"/"0" is
    # treated as a normal chat model (conversational variant).
    reasoning_active = is_reasoner and norm_effort not in ("none", "off", "0")

    if reasoning_active:
        if genui_enabled:
            return "You are Peldrun a helpful Assistant, and concise assistant. Respond naturally and directly."
        return "You are Peldrun a helpful Assistant, and concise assistant. Respond naturally and directly using Markdown."
    else:
        if genui_enabled:
            return "You are Peldrun a helpful Assistant, direct, and conversational AI assistant. Respond naturally and directly."
        return "You are Peldrun a helpful Assistant, direct, and conversational AI assistant. Respond directly and accurately using Markdown."


def build_optimized_chat_messages(
    turns: List[Dict[str, Any]],
    current_prompt: str,
    model_name: str,
    reasoning_effort: str,
    active_llm: Optional[Dict[str, Any]] = None,
    generative_ui: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, str]]:
    """
    Construct chat completion messages for conversational pipelines.

    [FIX-SYSTEM-PROMPT-ALWAYS-PRESENT] ``generative_ui`` is forwarded to
    ``resolve_chat_system_prompt`` so the GenUI-aware variant is actually
    selected when the user has it enabled. Before this change the
    argument was silently absent, forcing ``genui_enabled=False`` in
    every chat run.

    The ``system`` role is appended unconditionally. This is safe because
    ``resolve_chat_system_prompt`` is contractually guaranteed to return
    a non-empty string. The previous ``if sys_prompt:`` guard silently
    dropped the system role whenever the resolver returned ``None`` --
    masking the root cause.

    HISTORY WINDOW
    --------------
    ``turns[-6:]`` is the historical short-window fallback used when no
    sidecar is available. The live chat path builds messages through
    ``ContextManager.build_messages`` instead; this helper remains for
    callers that need a minimal, budget-free message list. The window
    size is part of the original behavior and is not a tuning knob.
    """
    messages: List[Dict[str, str]] = []

    sys_prompt = resolve_chat_system_prompt(
        model_name=model_name,
        reasoning_effort=reasoning_effort,
        active_llm=active_llm,
        generative_ui=generative_ui,
    )
    messages.append({"role": "system", "content": sys_prompt})

    for t in turns[-6:]:
        p = t.get("prompt")
        r = t.get("result")
        if p:
            messages.append({"role": "user", "content": p})
        if r:
            messages.append({"role": "assistant", "content": r})

    messages.append({"role": "user", "content": current_prompt})
    return messages


__all__ = [
    "resolve_chat_system_prompt",
    "build_optimized_chat_messages",
]

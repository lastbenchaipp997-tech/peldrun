# backend/omweb/agent_bridge_parts/dispatcher/chat_reasoning.py
"""
Chat-mode reasoning intent: effort resolution + provider request config.

Extracted verbatim from ``run_direct_chat``. CHAT-ONLY.

WHY CHAT DIFFERS FROM AGENT
---------------------------
Agent mode calls ``llm_runtime_config.normalize_reasoning_effort``, which
rewrites ``active_llm["reasoning_effort"]`` in place. Chat mode must NOT
do that: it needs the raw value to decide whether the model is a reasoner
at all, and it maps "reasoning off" to an EXPLICIT provider signal rather
than to silence.

The two-stage resolution below is therefore chat-specific:

    is_reasoner      = is_reasoning_model(model, active_llm)
    raw_effort       = normalized active_llm value IF reasoner ELSE "none"
    reasoning_effort = "none" IF raw in ("none","off","0") ELSE raw

Note the asymmetry inside stage 2: a NON-reasoner never even reads the
configured effort. A reasoner with effort "none" still ends up with
enabled=True below -- that is deliberate, see ``build_reasoning_config``.

REQUEST MAPPING (do not "simplify")
-----------------------------------
    non-reasoner                 -> enabled=False, mode=NONE
    reasoner, effort="none"      -> enabled=True,  mode=EFFORT, effort="none"
    reasoner, known effort       -> enabled=True,  mode=EFFORT, effort=<v>
    reasoner, anything else      -> enabled=True,  mode=ADAPTIVE

The second row is the load-bearing one: sending ``reasoning_effort="none"``
is the explicit "please do not think" signal some models require. Collapsing
it into ``enabled=False`` would silently re-enable thinking on those models.

The recognized effort set is exactly ("low","medium","high","minimal","xhigh").
Any other non-empty value falls through to ADAPTIVE, not to an error.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional, Tuple

from peldrun.llm.contracts import ReasoningMode
from peldrun.llm.request import ReasoningConfig

from .model_resolution import is_reasoning_model

logger = logging.getLogger(__name__)

# Effort values that map to ReasoningMode.EFFORT verbatim. Everything
# else (except the "off" spellings) becomes ADAPTIVE.
KNOWN_EFFORTS = ("low", "medium", "high", "minimal", "xhigh")

# Spellings that mean "reasoning disabled" across UI / config / API.
_OFF_SPELLINGS = ("none", "off", "0")


def resolve_chat_reasoning_effort(
    model_name: str,
    active_llm: Optional[Dict[str, Any]] = None,
) -> Tuple[bool, str, str]:
    """
    Resolve ``(is_reasoner, raw_effort, reasoning_effort)`` for chat mode.

    Pure: no logging, no mutation of ``active_llm``. ``raw_effort`` is
    returned only because the historical debug line reports it alongside
    the final value; the request itself uses ``reasoning_effort``.
    """
    is_reasoner = is_reasoning_model(model_name, active_llm=active_llm)
    raw_effort = (
        str((active_llm or {}).get("reasoning_effort") or "none").lower().strip()
        if is_reasoner
        else "none"
    )
    reasoning_effort = "none" if raw_effort in _OFF_SPELLINGS else raw_effort
    return (is_reasoner, raw_effort, reasoning_effort)


def log_reasoning_resolution(
    active_llm: Optional[Dict[str, Any]],
    is_reasoner: bool,
    raw_effort: str,
    reasoning_effort: str,
) -> None:
    """
    Emit the historical chat reasoning-resolution DEBUG line.

    Kept separate from the resolver so the resolver stays pure and
    unit-testable without log capture. Rendered message is byte-identical
    to the original inline call.
    """
    _llm = active_llm or {}
    logger.debug(
        "[BRIDGE DIRECT CHAT] is_reasoner=%s raw_effort=%r "
        "reasoning_effort=%r provider=%r base_url=%r",
        is_reasoner,
        raw_effort,
        reasoning_effort,
        _llm.get("provider"),
        _llm.get("base_url"),
    )


def build_reasoning_config(
    is_reasoner: bool,
    reasoning_effort: str,
) -> ReasoningConfig:
    """
    Build the provider-facing reasoning intent. See the module docstring
    for the full mapping and why effort="none" is NOT enabled=False.
    """
    if not is_reasoner:
        return ReasoningConfig(
            enabled=False, mode=ReasoningMode.NONE,
        )
    if reasoning_effort == "none":
        return ReasoningConfig(
            enabled=True,
            mode=ReasoningMode.EFFORT,
            effort="none",
        )
    if reasoning_effort in KNOWN_EFFORTS:
        return ReasoningConfig(
            enabled=True,
            mode=ReasoningMode.EFFORT,
            effort=reasoning_effort,
        )
    return ReasoningConfig(
        enabled=True, mode=ReasoningMode.ADAPTIVE,
    )


__all__ = [
    "KNOWN_EFFORTS",
    "resolve_chat_reasoning_effort",
    "log_reasoning_resolution",
    "build_reasoning_config",
]

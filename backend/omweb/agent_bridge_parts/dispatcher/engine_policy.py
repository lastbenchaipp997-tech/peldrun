# backend/omweb/agent_bridge_parts/dispatcher/engine_policy.py
"""
Execution-engine policy for the PELDRUN Universal Agent Bridge.

Extracted from ``dispatcher.py`` (PR 1: Single Execution Authority &
PeldrunWeb Decoupling). Behavior is preserved verbatim.

WHY THIS IS ITS OWN MODULE
--------------------------
This is the policy boundary that guarantees PELDRUN Core is the ONLY
execution engine. It is deliberately dependency-free:

  * No ``omweb`` imports -- importing it never pulls in the router /
    agent-bridge import graph.
  * No ``peldrun`` imports -- no SDK bootstrap, no registry side effects.
  * No I/O, no state, no logging -- a pure decision function.

That makes it importable in complete isolation (unit tests, CLI tools,
migration scripts) and trivially auditable: the whole security contract
fits on one screen.

CONTRACT
--------
``validate_requested_engine(value)`` has exactly three outcomes:

  1. Empty / missing input      -> returns ``SUPPORTED_ENGINE``.
     An unspecified engine is not an error; it means "use the default".
  2. A legacy PeldrunWeb id      -> raises ``ValueError`` with the
     explicit "no longer supported" message.
  3. Any other unrecognized id  -> raises ``ValueError`` with the
     generic "unsupported engine" message.

Only outcome 1 and the recognized-alias path return normally, and they
always return the SAME canonical string. Callers can therefore treat the
return value as a normalized constant, never as user-controlled text.

ORDERING NOTE
-------------
The legacy check runs BEFORE the alias check on purpose. A legacy id
must produce the specific, actionable "PeldrunWeb is no longer supported"
message rather than the generic "unsupported engine" one. Reordering
these two blocks would silently degrade the error the user sees.
"""
from __future__ import annotations

from typing import Optional

# Canonical engine identifier. Every successful validation returns this
# exact string, so downstream code (engine_registry.get, SSE payloads,
# session logs) never has to normalize anything itself.
SUPPORTED_ENGINE = "peldrun"

# Engine ids from the removed PeldrunWeb execution path. Kept as an
# explicit deny-list so callers receive a clear, actionable message
# instead of a generic "unknown engine" error.
#
# NOTE: these are plain ``set`` objects, matching the original dispatcher
# exactly. Treat them as READ-ONLY. Converting them to ``frozenset`` would
# be a cleaner constant declaration but would change the exported type,
# so it is deferred until the migration is complete.
LEGACY_ENGINE_IDS = {"PeldrunWeb", "legacy", "PeldrunApp"}

# Accepted spellings of the single supported engine. All of them
# normalize to SUPPORTED_ENGINE.
VALID_CORE_ALIASES = {"peldrun", "peldrun-core", "core"}


def validate_requested_engine(value: Optional[str]) -> str:
    """
    Validate engine identifier during runtime dispatch.

    Explicitly rejects PeldrunWeb identifiers and validates against
    supported core aliases. Returns the canonical engine identifier
    'peldrun'.

    Parameters
    ----------
    value
        The engine id as supplied by the caller (request body,
        ``llm_override``, or a legacy positional argument). May be
        ``None``, empty, or any object -- it is coerced with ``str()``
        before comparison, exactly as the original implementation did.

    Returns
    -------
    str
        Always ``SUPPORTED_ENGINE`` ("peldrun").

    Raises
    ------
    ValueError
        If the id belongs to the removed PeldrunWeb path, or is not a
        recognized alias of PELDRUN Core. The message text is part of
        the user-visible contract: it is forwarded verbatim into the
        job failure reason and the ERROR SSE payload.
    """
    # Unspecified engine -> default. Note this also covers falsy
    # non-string inputs (0, False, [], {}) because ``not value`` is
    # evaluated before any coercion.
    if not value or not str(value).strip():
        return SUPPORTED_ENGINE

    engine_id = str(value).strip().lower()

    # Legacy PeldrunWeb ids get a dedicated, actionable message.
    if engine_id in LEGACY_ENGINE_IDS:
        raise ValueError(
            "PeldrunWeb is no longer supported. PELDRUN Core is the only execution engine."
        )

    # Anything else that is not a known alias is rejected.
    #
    # The message interpolates the ORIGINAL ``value``, not the
    # normalized ``engine_id``: the user must see exactly what they
    # sent (original casing and surrounding whitespace) to be able to
    # diagnose a typo. Do not "clean this up" to use engine_id.
    if engine_id not in VALID_CORE_ALIASES:
        raise ValueError(
            f"Unsupported execution engine: '{value}'. PELDRUN Core is the only execution engine."
        )

    return SUPPORTED_ENGINE


__all__ = [
    "SUPPORTED_ENGINE",
    "LEGACY_ENGINE_IDS",
    "VALID_CORE_ALIASES",
    "validate_requested_engine",
]

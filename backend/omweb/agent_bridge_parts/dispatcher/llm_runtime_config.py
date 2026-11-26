# backend/omweb/agent_bridge_parts/dispatcher/llm_runtime_config.py
"""
Effective LLM runtime configuration for BOTH dispatch modes.

Extracted from the inlined (and duplicated) configuration blocks inside
``run_instrumented`` and ``run_direct_chat``. Every block is reproduced
verbatim; nothing is "cleaned up".

MODE ASYMMETRY -- DO NOT UNIFY
------------------------------
The two modes did NOT run the same blocks. Sharing the wrong block would
change production behavior:

    merge_active_llm                 agent + chat
    apply_generative_ui_fallback     agent + chat
    normalize_reasoning_effort       AGENT ONLY
    apply_runtime_timeouts           agent + chat (different log subject)
    apply_vault_base_url_override    AGENT ONLY
    resolve_display_target           agent + chat
    apply_model_limits               agent + chat (different log prefix)

``normalize_reasoning_effort`` and ``apply_vault_base_url_override`` are
kept as separate, explicitly agent-only calls. Chat mode resolves its
reasoning effort locally (it needs the raw value for the ReasoningConfig
mapping) and never consults the vault for base_url.

KNOWN QUIRK -- PRESERVED ON PURPOSE
-----------------------------------
``merge_active_llm`` ends with ``active_llm.update(llm_override)``, which
re-inserts EVERY override key -- including the ``None`` values the
preceding loop deliberately skipped. The loop is therefore effectively
dead code. This is pre-existing behavior, not a refactor artifact.
Removing the ``update`` call would change the effective config of every
request that passes an explicit ``None``. It is left untouched and
flagged here for a separate, deliberate decision after the migration.

IMPORT DISCIPLINE
-----------------
``read_active_toml_config`` is a module-level import (as in the legacy
dispatcher). Everything else -- ``generative_ui_store``,
``runtime_settings``, ``config_rtr`` -- stays INSIDE its function.
Hoisting ``config_rtr`` in particular reintroduces the
dispatcher -> routers -> agent_bridge -> dispatcher cycle.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional, Tuple

from ..config_loader import read_active_toml_config
from .model_resolution import (
    read_model_metadata_entry,
    resolve_model_context_window,
    resolve_model_max_output_tokens,
    resolve_model_temperature,
)

logger = logging.getLogger(__name__)


def merge_active_llm(llm_override: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Build ``active_llm`` from config.toml plus the per-request override.

    Returns a NEW dict; the caller's ``llm_override`` is never mutated
    (the dispatch entry points shallow-copy it before popping refs).

    See the module docstring for the preserved ``update()`` quirk.
    """
    toml_cfg = read_active_toml_config()
    active_llm = dict(toml_cfg.get("llm", {}))
    if llm_override:
        for k, v in llm_override.items():
            if v is not None:
                active_llm[k] = v
        if llm_override.get("provider_name"):
            active_llm["provider_name"] = llm_override["provider_name"]
        elif llm_override.get("provider"):
            active_llm["provider_name"] = llm_override["provider"]
        elif llm_override.get("model") and llm_override["model"] != active_llm.get("model"):
            if "1234" not in str(active_llm.get("base_url", "")):
                active_llm["provider_name"] = active_llm.get("provider") or active_llm.get("model")
        # NOTE: preserved quirk -- re-inserts None-valued keys. See the
        # module docstring. Do not remove without a behavior decision.
        active_llm.update(llm_override)
    return active_llm


def apply_generative_ui_fallback(active_llm: Dict[str, Any], job_id: str) -> None:
    """
    [FIX-GENUI-DISK] Populate ``generative_ui`` from the on-disk store.

    The frontend no longer ships ``generative_ui`` per request, so
    without this fallback the engine/context-builder would always see it
    as missing and silently render with GenUI disabled.

    Only fills the value when absent/falsy -- an explicit per-request
    override always wins. Best-effort: a broken store never blocks a run.
    """
    if not active_llm.get("generative_ui"):
        try:
            from ..generative_ui_store import load_generative_ui_settings
            active_llm["generative_ui"] = load_generative_ui_settings()
        except Exception as _genui_err:
            logger.debug(
                "Could not load GenUI settings from disk for job %s: %s",
                job_id,
                _genui_err,
            )


def normalize_reasoning_effort(active_llm: Dict[str, Any]) -> None:
    """
    Collapse the "reasoning off" spellings to the canonical ``"none"``.

    AGENT MODE ONLY. Chat mode must NOT call this: it needs the raw
    effort value to build its ReasoningConfig mapping (a reasoner with
    effort="none" still sends an explicit "please don't think" signal).

    Note the guard: a falsy value (None, "", 0) is left completely
    untouched rather than being set to "none".
    """
    if "reasoning_effort" in active_llm and active_llm["reasoning_effort"]:
        raw_eff = str(active_llm["reasoning_effort"]).lower().strip()
        if raw_eff in ("none", "off", "0"):
            active_llm["reasoning_effort"] = "none"


def apply_runtime_timeouts(
    active_llm: Dict[str, Any],
    llm_override: Optional[Dict[str, Any]],
    job_id: str,
    *,
    job_label: str = "job",
) -> None:
    """
    [FIX-RUNTIME-TIMEOUTS] Apply /settings/runtime timeout overrides.

    Precedence per field:
      1. Per-request ``llm_override`` (explicit caller intent) -- wins.
      2. ``runtime_settings.json`` (the user's persistent UI choice).
      3. Whatever config.toml / active_llm already holds.

    Each of the three keys is resolved INDEPENDENTLY, so a caller can
    override just one without disturbing the other two.

    ``job_label`` reproduces the two historical log subjects: agent
    passes ``"job"``, chat passes ``"chat job"``. The rendered debug
    message is byte-identical to both originals.

    Best-effort: a broken runtime_settings.json must never block a run.
    """
    try:
        from omweb.services.runtime_settings import resolve as _rt_resolve

        def _apply_rt_timeout(active_key: str, rt_key: str) -> None:
            if (
                isinstance(llm_override, dict)
                and llm_override.get(active_key) is not None
            ):
                return  # explicit per-request override wins
            rt_val = _rt_resolve("timeouts", rt_key)
            if rt_val is not None:
                active_llm[active_key] = float(rt_val)

        _apply_rt_timeout("timeout", "llm_request_timeout_seconds")
        _apply_rt_timeout("step_timeout", "step_timeout_seconds")
        _apply_rt_timeout("total_timeout", "total_timeout_seconds")
    except Exception as _rt_err:
        logger.debug(
            "Runtime timeout overrides skipped for %s %s: %s",
            job_label,
            job_id,
            _rt_err,
        )


def apply_vault_base_url_override(active_llm: Dict[str, Any], job_id: str) -> None:
    """
    [FIX-VAULT-SOURCE-OF-TRUTH] Prefer the Store-saved local base_url.

    AGENT MODE ONLY -- chat mode never performed this override.

    For local providers, the value the Store UI persisted in
    ``models_vault.json`` outranks any stale ``base_url`` from
    config.toml or the browser's ``active_llm_override`` localStorage
    entry. This eliminates the "Test Connection succeeds but the agent
    fails" mismatch.

    The vault read lives in ``config_rtr.get_local_provider_base_url``:
    routers own file access, the dispatcher calls router helpers. No
    file I/O and no hardcoded paths here.

    Non-fatal: a broken vault read falls back to whatever config.toml /
    llm_override supplied.
    """
    try:
        from omweb.routers.config_rtr import get_local_provider_base_url
        _provider_hint = (
            active_llm.get("provider")
            or active_llm.get("provider_name")
            or ""
        )
        _vault_url = get_local_provider_base_url(str(_provider_hint))
        if _vault_url and _vault_url != str(active_llm.get("base_url") or ""):
            logger.info(
                "[BRIDGE] Vault override: replacing %r with %r for "
                "provider %r (job=%s).",
                active_llm.get("base_url"),
                _vault_url,
                _provider_hint,
                job_id,
            )
            active_llm["base_url"] = _vault_url
    except Exception as _vault_err:
        logger.debug(
            "Vault base_url override skipped for job %s: %s",
            job_id,
            _vault_err,
        )


def resolve_display_target(active_llm: Dict[str, Any]) -> Tuple[str, str, str]:
    """
    Resolve the (provider_name, model_name, base_url) triple.

    These three values feed SSE payloads, session logs, error messages
    and the LM Studio readiness probe. They are display/routing labels,
    NOT the adapter routing decision (that is ``provider_routing``).

    The "LM Studio" special case: when the endpoint is clearly not a
    local LM Studio instance (no "1234" in the URL and no "lmstudio" in
    the provider id) but the display name still says "LM Studio", the
    label is replaced by the provider id / model / "Custom Engine".
    This prevents a renamed custom endpoint from being mislabelled and
    from triggering the LM Studio readiness probe.

    ``api_key`` is deliberately NOT returned: agent mode reads it with a
    ``""`` default while chat mode uses ``"EMPTY"``. Unifying the default
    would change the Authorization header for one of the two modes.

    NOTE: ``p_cand`` is used with ``.lower()`` without a ``str()`` cast,
    exactly as the original. A non-string ``provider_name`` therefore
    raises AttributeError here as it did before. Not hardened on
    purpose -- behavior preservation.
    """
    p_cand = active_llm.get("provider_name") or active_llm.get("provider") or ""
    b_cand = str(active_llm.get("base_url") or "")
    if "1234" not in b_cand and "lmstudio" not in str(active_llm.get("provider") or "").lower():
        if "lm studio" in p_cand.lower():
            p_cand = active_llm.get("provider") or active_llm.get("model") or "Custom Engine"
    provider_name = p_cand or "Active Primary"
    model_name = active_llm.get("model") or "default"
    base_url = b_cand or "http://127.0.0.1:1234/v1"
    return (provider_name, model_name, base_url)


def apply_model_limits(
    active_llm: Dict[str, Any],
    model_name: str,
    *,
    log_prefix: str,
) -> int:
    """
    [FIX-METADATA-SOURCE-OF-TRUTH] + [FIX-PER-MODEL-TEMP] in one place.

    Writes into ``active_llm``:
      * ``context_window``    -- from metadata, only when > 0.
      * ``max_tokens`` and ``max_output_tokens`` -- the SAME resolved
        value (both keys are kept because different downstream readers
        look at different names).
      * ``temperature``       -- only when a per-model value resolves;
        otherwise the existing value is left untouched so the caller's
        historical default survives.

    ``log_prefix`` must be ``"[BRIDGE]"`` (agent) or
    ``"[BRIDGE DIRECT CHAT]"`` (chat). Both original log calls render to
    the same format string, so one implementation covers both.

    Returns the resolved max output tokens, which chat mode also passes
    into ``GenerationConfig``.

    The ``source: metadata|fallback`` field costs one extra metadata
    read purely for observability. Preserved as-is.
    """
    _resolved_ctx = resolve_model_context_window(model_name, active_llm)
    if _resolved_ctx > 0:
        active_llm["context_window"] = _resolved_ctx

    resolved_max_tokens = resolve_model_max_output_tokens(model_name, active_llm)
    active_llm["max_tokens"] = resolved_max_tokens
    active_llm["max_output_tokens"] = resolved_max_tokens

    logger.info(
        f"{log_prefix} Resolved limits for %r: context_window=%d, "
        "max_tokens=%d (source: %s)",
        model_name,
        active_llm["context_window"],
        resolved_max_tokens,
        "metadata" if read_model_metadata_entry(model_name) else "fallback",
    )

    resolved_temperature = resolve_model_temperature(model_name, active_llm)
    if resolved_temperature is not None:
        active_llm["temperature"] = resolved_temperature

    return resolved_max_tokens


__all__ = [
    "merge_active_llm",
    "apply_generative_ui_fallback",
    "normalize_reasoning_effort",
    "apply_runtime_timeouts",
    "apply_vault_base_url_override",
    "resolve_display_target",
    "apply_model_limits",
]

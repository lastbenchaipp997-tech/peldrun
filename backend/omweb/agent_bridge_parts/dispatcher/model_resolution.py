# backend/omweb/agent_bridge_parts/dispatcher/model_resolution.py
"""
Model fact resolution for the PELDRUN Universal Agent Bridge.

Extracted from ``dispatcher.py`` as part of the dispatcher decomposition.
Behavior is preserved verbatim: every resolution layer, priority order,
fallback value and failure mode is identical to the original code.

This module is a PURE LEAF:
  * No ``omweb`` imports at module load time.
  * No import of ``dispatcher`` or any dispatch module (that would
    reintroduce the cycle this decomposition removes).
  * Heavy / optional dependencies (``peldrun.storage_paths``,
    ``peldrun.llm.providers.registry``) are imported lazily inside the
    functions that need them, exactly as before.

NOTE ON PATH RESOLUTION (depth-sensitive -- read before relocating)
-------------------------------------------------------------------
``_storage_candidates`` reproduces the legacy candidate list exactly,
including the ``backend/storage`` fallback. That fallback is anchored
to the ``backend`` directory via ``_BACKEND_DIR`` below.

The original ``dispatcher.py`` lived at
``backend/omweb/agent_bridge_parts/dispatcher.py`` and computed the
anchor as ``Path(__file__).resolve().parent.parent.parent`` (3 hops
from the file == ``parents[2]``).

This module lives ONE LEVEL DEEPER, inside the ``dispatcher`` package,
so the same anchor requires ``parents[3]``. Using ``parents[2]`` here
would silently resolve to ``backend/omweb/storage`` and read the wrong
files WITHOUT raising -- the exact class of regression this package
split must avoid.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Absolute ceiling -- guards against corrupted files only.
# 131072 (128K) is larger than any current model's output cap.
# Previously a function-local constant in _resolve_model_max_output_tokens;
# hoisted to module scope without changing its value or semantics.
_ABSOLUTE_CEILING = 131072

_METADATA_FILENAME = "models_metadata.json"
_BUDGET_FILENAME = "models_budget.json"

# Absolute anchor for the legacy ``backend/storage`` read-only fallback.
#
# This file is located at:
#   backend/omweb/agent_bridge_parts/dispatcher/model_resolution.py
#
#   parents[0] -> backend/omweb/agent_bridge_parts/dispatcher
#   parents[1] -> backend/omweb/agent_bridge_parts
#   parents[2] -> backend/omweb
#   parents[3] -> backend            <-- required anchor
#
# Equivalent to the original dispatcher.py expression
# ``Path(__file__).resolve().parent.parent.parent`` adjusted for the
# extra package level. Do NOT change the index without re-checking
# every legacy candidate path against a real installation.
_BACKEND_DIR = Path(__file__).resolve().parents[3]


def _storage_candidates(filename: str) -> List[Path]:
    """
    Build the ordered candidate paths for a storage JSON file.

    Order (highest -> lowest priority), identical to the four inlined
    copies that previously existed in ``dispatcher.py``:

      1. Centralized storage root (``peldrun.storage_paths``).
      2. ``backend/storage/<filename>`` relative to this module.
      3. ``storage/<filename>`` relative to the process CWD.
      4. ``backend/storage/<filename>`` relative to the process CWD.

    Candidates 2-4 are READ-ONLY legacy fallbacks kept so existing users
    with data in the old locations still see their metadata until they
    move it manually (audit items 2.2 + 2.3).

    Raises whatever ``get_storage_root()`` raises. Every caller invokes
    this inside its own try/except, so an import or storage-root failure
    degrades to the next resolution layer exactly as it did before.
    """
    from peldrun.storage_paths import get_storage_root

    canonical = get_storage_root() / filename
    return [
        canonical,
        _BACKEND_DIR / "storage" / filename,
        Path(f"storage/{filename}").resolve(),
        Path(f"backend/storage/{filename}").resolve(),
    ]


def read_model_metadata_entry(model_name: str) -> Optional[Dict[str, Any]]:
    """
    Read one model's entry from `models_metadata.json`.

    ``models_metadata.json`` is the single source of truth for
    provider-discovered facts about a model: ``max_context_length``,
    ``max_output_tokens``, capabilities, reasoning mode, etc. The
    user's per-model overrides in ``models_budget.json`` sit on top
    of these facts, and ``config.toml`` is a legacy fallback that
    MAY carry stale values.

    Returns ``None`` on any read/parse failure -- the caller falls
    through to the other resolution layers.
    """
    try:
        for p in _storage_candidates(_METADATA_FILENAME):
            if not p.exists():
                continue
            data = json.loads(p.read_text(encoding="utf-8"))
            entry = data.get(model_name) or data.get(model_name.lower())
            if isinstance(entry, dict):
                return entry
    except Exception as exc:
        logger.debug(
            "Could not read metadata for %r: %s", model_name, exc
        )
    return None


def check_model_metadata_reasoning(model_name: str) -> Optional[bool]:
    """
    Check persisted models_metadata.json for explicit reasoning capability.

    Allows user settings and model discovery metadata to act as source of truth.
    Safely resolves across working directories and relative paths.
    """
    try:
        for p in _storage_candidates(_METADATA_FILENAME):
            if p.exists():
                data = json.loads(p.read_text(encoding="utf-8"))
                # Try both the exact name and the lowercased variant --
                # metadata is written with mixed casing by different
                # discovery paths.
                meta = data.get(model_name) or data.get(model_name.lower())
                if not isinstance(meta, dict):
                    continue
                # [FIX-NONE-IS-NOT-FALSE] ``None`` means "unknown" (the
                # provider did not report a reasoning capability for
                # this model). It MUST NOT be conflated with ``False``
                # ("provider explicitly denied reasoning"). Conflating
                # them caused adapter family knowledge to be blocked
                # by an auto-scan entry that merely had no data.
                caps = meta.get("capabilities", {})
                if isinstance(caps, dict) and "reasoning" in caps:
                    val = caps["reasoning"]
                    if val is None:
                        return None
                    return bool(val)
                if "is_reasoning" in meta:
                    val = meta["is_reasoning"]
                    if val is None:
                        return None
                    return bool(val)
                if "reasoning" in meta:
                    val = meta["reasoning"]
                    if val is None:
                        return None
                    return bool(val)
    except Exception as e:
        logger.debug(f"Could not load reasoning metadata for {model_name}: {e}")
    return None


def check_manual_reasoning_override(
    model_name: str,
) -> Optional[bool]:
    """
    Return the user's EXPLICIT reasoning override, or `None`.

    A manual override (``capability_sources.reasoning == "manual"``)
    is the ONLY signal that outranks the provider adapter's family
    knowledge. It represents a deliberate user decision in
    ModelInfoModal, not an automated scan guess.

    Returns
    -------
    True | False | None
        * True/False -- the user explicitly chose this value.
        * None       -- no manual override exists; the caller should
                        continue to the next layer.
    """
    try:
        for p in _storage_candidates(_METADATA_FILENAME):
            if not p.exists():
                continue
            data = json.loads(p.read_text(encoding="utf-8"))
            entry = data.get(model_name) or data.get(model_name.lower())
            if not isinstance(entry, dict):
                continue
            sources = entry.get("capability_sources") or {}
            if not isinstance(sources, dict):
                continue
            if sources.get("reasoning") != "manual":
                continue
            caps = entry.get("capabilities") or {}
            if isinstance(caps, dict) and "reasoning" in caps:
                val = caps["reasoning"]
                if val is not None:
                    return bool(val)
            if "is_reasoning" in entry and entry["is_reasoning"] is not None:
                return bool(entry["is_reasoning"])
            if "reasoning" in entry and entry["reasoning"] is not None:
                return bool(entry["reasoning"])
    except Exception as exc:
        logger.debug(
            "[BRIDGE] Manual reasoning override lookup failed for "
            "%r: %s",
            model_name,
            exc,
        )
    return None


def check_adapter_reasoning_opinion(
    model_name: str,
    active_llm: Optional[Dict[str, Any]],
) -> Optional[bool]:
    """
    Query the provider adapter for its reasoning family knowledge.

    Returns ``True`` / ``False`` when the adapter recognises the
    model family, or ``None`` when the adapter has no opinion
    (unknown model, unregistered provider, or a legacy alias that
    no native equivalent can resolve).

    Legacy ids (``openai`` / ``lmstudio`` / ``ollama`` / ``deepseek``)
    are projected onto their native equivalents exactly as
    ``/api/config/reasoning-capabilities`` does it, so the dispatcher
    and the UI always agree about which models reason.
    """
    if not (active_llm and model_name):
        return None

    # ``provider`` is the normalized id the frontend writes
    # (``activeProvider.toLowerCase().replace(/[^a-z0-9]/g, "")``).
    # Fall back to the display name for legacy configs.
    _provider_id = str(active_llm.get("provider") or "").strip().lower()
    if not _provider_id:
        _provider_name = str(
            active_llm.get("provider_name") or ""
        ).strip().lower()
        if _provider_name:
            _provider_id = "".join(
                c for c in _provider_name if c.isalnum()
            )
    if not _provider_id:
        return None

    try:
        from peldrun.llm.providers.registry import provider_registry

        reg = provider_registry.find(_provider_id)
        adapter_class = (
            reg.adapter_class if reg is not None else None
        )
        # Project legacy registrations onto their native equivalent
        # (e.g. "lmstudio" -> lmstudio_native, "deepseek" ->
        # deepseek_native). Mirrors _resolve_native_adapter.
        if (
            adapter_class is not None
            and getattr(adapter_class, "ADAPTER_STYLE", "legacy")
            != "v1"
        ):
            for _native_id in (
                f"{reg.provider_id}_native",
                f"{_provider_id}_native",
            ):
                _native_reg = provider_registry.find(_native_id)
                if (
                    _native_reg is not None
                    and _native_reg.adapter_class is not None
                ):
                    adapter_class = _native_reg.adapter_class
                    break
        if adapter_class is not None:
            _method = getattr(
                adapter_class, "get_reasoning_options", None
            )
            if callable(_method):
                descriptor = _method(model_name, None)
                if descriptor is not None:
                    return bool(descriptor.supported)
    except Exception as exc:
        logger.debug(
            "[BRIDGE] Adapter reasoning lookup failed for "
            "provider=%r model=%r: %s",
            _provider_id,
            model_name,
            exc,
        )
    return None


def resolve_model_context_window(
    model_name: str,
    active_llm: Optional[Dict[str, Any]] = None,
) -> int:
    """
    Resolve the model's context window in tokens.

    Priority order (highest -> lowest):
      1. ``models_metadata.json`` -> ``max_context_length``
         (This is the authoritative value discovered from the provider's
         live catalog -- e.g., LM Studio's ``/api/v1/models`` response.
         The user's config.toml may carry a stale or hand-edited value,
         which is why this is preferred.)
      2. ``active_llm`` -> ``context_window`` (config.toml fallback for
         custom endpoints that have no metadata entry).
      3. Default 8192 (safe for any chat model).

    This value is used to compute ``effective_limit`` in the token
    budget, and to cap ``max_output_tokens`` in
    ``resolve_model_max_output_tokens``. Reading it from metadata
    instead of config.toml prevents the "context_window=1048576 in
    config.toml but actual model loaded with 8192" mismatch that
    silently caused 400 errors from LM Studio.
    """
    meta = read_model_metadata_entry(model_name)
    if meta:
        for key in ("max_context_length", "context_length", "context_window"):
            val = meta.get(key)
            if isinstance(val, int) and val > 0:
                return val
    if active_llm:
        val = active_llm.get("context_window")
        if val is not None:
            try:
                parsed = int(val)
                if parsed > 0:
                    return parsed
            except (ValueError, TypeError):
                pass
    return 8192


def resolve_model_max_output_tokens(
    model_name: str,
    active_llm: Optional[Dict[str, Any]] = None,
) -> int:
    """
    Resolve max output tokens for the target model.

    Priority order (highest -> lowest):
      1. ``models_budget.json`` -> ``max_output_tokens`` / ``max_tokens``
         (Explicit user override in the Model Budgets UI. This is the
         HIGHEST priority because the user deliberately chose this
         value in the UI. Ignoring it was the root cause of the
         Gemini 2.5/3.x finish_reason='length' failures: the user
         configured 65536, a hardcoded cap silently reduced it to
         4096, and the model burned the entire budget on reasoning.)
      2. ``models_metadata.json`` -> ``max_output_tokens``
         (Provider-discovered authoritative value from the last
         Scan Models run.)
      3. Derive from metadata's ``max_context_length // 4``
         (with the LOADED context as an additional cap when present).
      4. ``active_llm["max_output_tokens"]`` / ``["max_tokens"]``
         (config.toml fallback for custom endpoints.)
      5. Default 2048.

    Safety
    ------
    The only hardcoded bound is ``_ABSOLUTE_CEILING = 131072``
    (128K) -- a guard against corrupted files containing absurd
    values such as ``999_999_999``. It never interferes with a
    legitimate model configuration: every current chat model
    supports at most 128K output, so any value at or below that is
    trusted as-is.

    The LM Studio "HTTP 400 from small loaded context" failure is
    handled by a DIFFERENT mechanism: when the model's metadata
    carries ``loaded_context_length`` (or the equivalent nested
    ``loaded_instances[0].config.context_length``), we cap the
    output at ``loaded_context // 2`` -- preserving the original
    protection without the collateral damage of a global 4096 cap.

    The blanket ``MAX_SAFE_OUTPUT_TOKENS = 4096`` was removed
    because it silently overrode the user's explicit budget
    setting AND the provider's authoritative declaration. Both
    files exist precisely to be the source of truth; re-clamping
    their values defeats their purpose.
    """
    # ------------------------------------------------------------------
    # Layer 1 -- models_budget.json (explicit user override).
    #
    # This is the Model Budgets UI's persistence target. The user
    # explicitly set these values, so they MUST win over provider
    # metadata. Previously this was Layer 2 (below metadata), which
    # caused user overrides to be silently discarded.
    # ------------------------------------------------------------------
    try:
        for p in _storage_candidates(_BUDGET_FILENAME):
            if p.exists():
                data = json.loads(p.read_text(encoding="utf-8"))
                cfg = data.get(model_name) or data.get(model_name.lower())
                if isinstance(cfg, dict):
                    budget_val = cfg.get("max_output_tokens") or cfg.get("max_tokens")
                    if budget_val is not None:
                        parsed_val = int(budget_val)
                        if parsed_val > 0:
                            return min(parsed_val, _ABSOLUTE_CEILING)
    except Exception as e:
        logger.debug("Could not load budget cache for %s: %s", model_name, e)

    # ------------------------------------------------------------------
    # Layer 2 -- models_metadata.json (provider-discovered).
    # ------------------------------------------------------------------
    meta = read_model_metadata_entry(model_name)
    if meta:
        # Extract the ACTUAL loaded context (LM Studio / Ollama
        # expose this; cloud providers do not). Two shapes:
        #   - Top-level ``loaded_context_length``
        #   - Nested ``loaded_instances[0].config.context_length``
        loaded_ctx: Optional[int] = None
        raw_loaded_top = meta.get("loaded_context_length")
        if isinstance(raw_loaded_top, int) and raw_loaded_top > 0:
            loaded_ctx = raw_loaded_top
        else:
            loaded_list = meta.get("loaded_instances")
            if isinstance(loaded_list, list) and loaded_list:
                first_inst = loaded_list[0]
                if isinstance(first_inst, dict):
                    inst_cfg = first_inst.get("config")
                    if isinstance(inst_cfg, dict):
                        nested_ctx = inst_cfg.get("context_length")
                        if isinstance(nested_ctx, int) and nested_ctx > 0:
                            loaded_ctx = nested_ctx

        meta_out = meta.get("max_output_tokens")
        if isinstance(meta_out, int) and meta_out > 0:
            # [FIX-LMSTUDIO-LOADED-CONTEXT] When the model is
            # loaded with a smaller context than the declared
            # max_output, cap the output at loaded // 2. This
            # preserves the original "HTTP 400 from LM Studio"
            # protection WITHOUT the collateral damage of a
            # global 4096 cap.
            #
            # Example:
            #   meta max_output_tokens = 65536
            #   loaded_context_length = 8192
            #   -> return min(65536, 8192 // 2) = 4096  (safe)
            #
            #   meta max_output_tokens = 65536 (Gemini)
            #   loaded_context_length = None
            #   -> return min(65536, 131072) = 65536  (correct)
            if loaded_ctx is not None and loaded_ctx > 0:
                return min(meta_out, loaded_ctx // 2, _ABSOLUTE_CEILING)
            return min(meta_out, _ABSOLUTE_CEILING)

        # Fallback: derive from max_context_length // 4.
        meta_ctx = meta.get("max_context_length")
        if isinstance(meta_ctx, int) and meta_ctx > 0:
            effective_ctx = meta_ctx
            if loaded_ctx is not None and loaded_ctx > 0:
                effective_ctx = min(meta_ctx, loaded_ctx)
            derived = max(256, effective_ctx // 4)
            return min(derived, _ABSOLUTE_CEILING)

    # ------------------------------------------------------------------
    # Layer 3 -- active_llm (config.toml fallback).
    # ------------------------------------------------------------------
    if active_llm:
        val = active_llm.get("max_output_tokens") or active_llm.get("max_tokens")
        if val is not None:
            try:
                parsed = int(val)
                if parsed > 0:
                    return min(parsed, _ABSOLUTE_CEILING)
            except (ValueError, TypeError):
                pass

    # ------------------------------------------------------------------
    # Layer 4 -- safe default.
    # ------------------------------------------------------------------
    return 2048


def resolve_model_temperature(
    model_name: str,
    active_llm: Optional[Dict[str, Any]] = None,
) -> Optional[float]:
    """
    Resolve the per-model sampling temperature.

    Priority order (highest -> lowest):
      1. Per-model `temperature` in storage/models_budget.json -- an explicit
         override the user set in the "Per-Model Context Windows" tab.
      2. Global `active_llm["temperature"]` (config.toml / per-request override).
      3. None -- caller falls back to its own historical default.

    Returns None when no value is available anywhere, signalling the caller
    to leave its default untouched. This preserves the historical behavior
    for models the user never configured (0.7 for chat, 0.2 for agent),
    instead of forcing a hardcoded value.
    """
    try:
        for p in _storage_candidates(_BUDGET_FILENAME):
            if p.exists():
                data = json.loads(p.read_text(encoding="utf-8"))
                cfg = data.get(model_name) or data.get(model_name.lower())
                if isinstance(cfg, dict) and "temperature" in cfg:
                    raw = cfg["temperature"]
                    if raw is not None:
                        parsed = float(raw)
                        # Clamp to a safe range -- reject nonsense values
                        # that would confuse the LLM provider.
                        if 0.0 <= parsed <= 2.0:
                            return parsed
    except Exception as e:
        logger.debug(
            "Could not load per-model temperature for %s: %s", model_name, e
        )
    if active_llm:
        raw = active_llm.get("temperature")
        if raw is not None:
            try:
                parsed = float(raw)
                if 0.0 <= parsed <= 2.0:
                    return parsed
            except (ValueError, TypeError):
                pass
    return None


def is_reasoning_model(
    model_name: str,
    active_llm: Optional[Dict[str, Any]] = None,
) -> bool:
    """
    Determine whether the target model supports reasoning.

    Layered resolution (highest -> lowest priority):
        1. **Manual user override** -- an explicit
           ``capability_sources.reasoning == "manual"`` entry in
           ``models_metadata.json``. The user's deliberate choice,
           written via ModelInfoModal, outranks everything.
        2. **Provider adapter family knowledge** -- the same
           ``get_reasoning_options()`` query that powers
           ``/api/config/reasoning-capabilities``. Authoritative for
           the model's own family (deepseek-v4/flash, gpt-5, o1,
           claude-4, ...).
        3. **Auto-scan metadata** -- ``capabilities.reasoning``
           written by Scan Models. Only reached when the adapter has
           no opinion (unknown model). ``None`` here means "unknown"
           and falls through.
        4. **Client hint** -- ``active_llm["is_reasoning_model"]`` from
           the frontend's name-based heuristic. Weaker than any
           provider signal; only used for models the backend cannot
           classify.
        5. **False** -- safe default (P5: uncertainty is "no
           reasoning", never a fabricated "yes").

    Design invariants
    -----------------
    * No hardcoded substring lists. Adding a new reasoning family
      requires ONE of:
        a) Scan Models writes ``capabilities.reasoning=True``
           (user-driven, zero code change), OR
        b) The adapter extends ``get_reasoning_options()``
           (adapter-driven, one file, no dispatcher change).
    * ``None`` from any layer means "no opinion" and falls through;
      only ``True`` / ``False`` short-circuits.
    * Every layer is best-effort. A broken metadata file, a
      missing adapter, or a registry import failure must never
      abort the run -- the next layer runs, and finally ``False``.
    """
    # Layer 1 -- explicit user override (highest priority).
    manual = check_manual_reasoning_override(model_name)
    if manual is not None:
        return manual

    # Layer 2 -- provider adapter family knowledge.
    adapter_opinion = check_adapter_reasoning_opinion(
        model_name, active_llm
    )
    if adapter_opinion is not None:
        return adapter_opinion

    # Layer 3 -- auto-scan metadata (only reached when the adapter
    # has no opinion, i.e. unknown model family).
    db_flag = check_model_metadata_reasoning(model_name)
    if db_flag is not None:
        return db_flag

    # Layer 4 -- client-side hint (weakest).
    if active_llm:
        if (
            active_llm.get("is_reasoning_model") is not None
        ):
            return bool(active_llm["is_reasoning_model"])
        if active_llm.get("is_reasoning") is not None:
            return bool(active_llm["is_reasoning"])

    # Layer 5 -- safe default.
    return False


__all__ = [
    "read_model_metadata_entry",
    "check_model_metadata_reasoning",
    "check_manual_reasoning_override",
    "check_adapter_reasoning_opinion",
    "resolve_model_context_window",
    "resolve_model_max_output_tokens",
    "resolve_model_temperature",
    "is_reasoning_model",
]

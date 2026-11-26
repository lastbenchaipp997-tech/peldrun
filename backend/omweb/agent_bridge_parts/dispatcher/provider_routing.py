# backend/omweb/agent_bridge_parts/dispatcher/provider_routing.py
"""
Provider routing for the PELDRUN Universal Agent Bridge.

Extracted from ``dispatcher.py`` as part of the dispatcher decomposition.
Answers one question: which adapter actually executes this request?

Resolution precedence (UNCHANGED -- do not reorder)
---------------------------------------------------
  1. Store-installed Provider Packages (SOURCE_EXTERNAL + custom_plugin)
  2. Built-in Native Adapters (SOURCE_BUILTIN + ADAPTER_STYLE == "v1")
  3. ``openai_compat`` -- the compatibility baseline

The plugin loop MUST run before the native lookup so a Store-installed
package always wins over a built-in name collision. The registry
protects built-in ids today, but the ordering documents the contract
and keeps it true if that protection ever changes.

IMPORT DISCIPLINE (critical)
----------------------------
Every ``omweb.*`` import and every ``provider_registry`` import stays
INSIDE the function that uses it. Hoisting any of them to module scope
reintroduces the module-load cycle the original file deliberately broke:

    dispatcher -> omweb.routers.__init__ -> run_routes / files
      -> omweb.agent_bridge -> agent_bridge_parts -> dispatcher

``PLUGIN_DESCRIPTOR_KEY`` is the one module-level import, matching the
original dispatcher exactly. It is a plain string constant and the
legacy module already imports it at load time, so this adds no new
startup cost.

BEHAVIORAL PARITY NOTES
-----------------------
* Log message strings are byte-identical to the original, including
  their non-ASCII characters. Log-based monitoring must not break.
* This module never reads ``__file__``; it has no path-depth coupling.
* No caller-visible signature changed except the removal of the
  leading underscore (the dispatcher facade re-aliases the old names).
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from peldrun.llm.providers.custom_plugin import PLUGIN_DESCRIPTOR_KEY

logger = logging.getLogger(__name__)


# =========================================================================
# [M7.3] Native adapter routing (data-driven, zero hard-coding)
# =========================================================================
# Routes a request to a Native Adapter ONLY when ALL of the following
# are true:
#
#   1. `use_native_adapters` is not explicitly disabled by config.
#   2. The provider's `api_type` is not an explicit opt-out
#      (`"chat_completions"` forces openai_compat).
#   3. The provider name resolves to a REGISTERED Native Adapter in
#      `provider_registry` (guarantees its SDK is installed).
#   4. Either the caller's `base_url` is empty (use the provider's
#      default endpoint), OR it contains one of the adapter's declared
#      `default_base_url_markers` (e.g. "googleapis.com" for Google).
#
# The markers live on each adapter's `_PROFILE` in
# `peldrun/llm/providers/*.py`. This module contains NO mapping
# table, NO marker list, NO alias list. Adding a new provider requires
# exactly ONE change (declare markers on the adapter's `_PROFILE`)
# and NO edits to this file.
#
# When ANY condition fails, the caller falls back to `openai_compat`
# -- the compatibility baseline that has always worked.
# =========================================================================


def native_adapters_enabled(active_llm: Dict[str, Any]) -> bool:
    """
    Return True when Native Adapter routing is enabled.

    Default: True (opt-out). The user can disable it per-deployment
    via config.toml::

        [llm]
        use_native_adapters = false

    This flag exists as an emergency escape hatch -- if a future
    provider SDK introduces a regression, the operator can revert to
    the openai_compat path without changing code.
    """
    raw = active_llm.get("use_native_adapters", True)
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        return raw.strip().lower() not in ("false", "0", "no", "off")
    return bool(raw)


def resolve_native_adapter(
    active_llm: Dict[str, Any],
    candidates: List[str],
) -> Optional[Tuple[str, Dict[str, Any]]]:
    """
    Resolve a Native Adapter for the active provider, or return None.

    Returning ``None`` signals the caller to fall back to
    ``openai_compat``. That fallback covers every "not sure" case --
    Custom Endpoints, missing SDKs, custom proxy URLs, and explicit
    opt-outs.

    Every routing signal comes from:
      * ``active_llm``        -- populated from config.toml / vault
      * ``provider_registry`` -- populated by providers/__init__.py
      * ``AdapterProfile``    -- declared on each adapter class

    Nothing is hard-coded here.
    """
    # Guard 1 -- feature flag.
    if not native_adapters_enabled(active_llm):
        logger.debug(
            "[BRIDGE] Native adapters disabled by config "
            "(use_native_adapters=false)."
        )
        return None

    # Lazy import: the dispatcher package is imported very early in
    # startup, and provider_registry triggers an expensive bootstrap.
    try:
        from peldrun.llm.providers.registry import (
            SOURCE_BUILTIN,
            provider_registry,
        )
    except Exception as exc:
        logger.debug(
            "[BRIDGE] provider_registry import failed; skipping native "
            "routing: %s",
            exc,
        )
        return None

    # Guard 2 -- explicit api_type override from the vault / request.
    #
    # The frontend's API mode selector writes this value. Honoring it
    # unconditionally means the user always retains final control --
    # even for a provider that WOULD have used a Native Adapter.
    api_type = str(active_llm.get("api_type") or "").strip().lower()
    if api_type in (
        "chat_completions", "chat-completions", "chat completions",
        "openai_compat", "openai-compat",
    ):
        logger.info(
            "[BRIDGE] api_type=%r explicitly forces openai_compat.",
            api_type,
        )
        return None

    if api_type in ("responses", "responses api", "responses-api"):
        reg = provider_registry.find("openai_native")
        if reg is not None and reg.source == SOURCE_BUILTIN:
            logger.info(
                "[BRIDGE] api_type=%r → openai_native.", api_type
            )
            return ("openai_native", {})
        return None

    if api_type in (
        "anthropic", "anthropic_messages", "anthropic-messages",
        "anthropic messages",
    ):
        reg = provider_registry.find("anthropic")
        if reg is not None and reg.source == SOURCE_BUILTIN:
            logger.info(
                "[BRIDGE] api_type=%r → anthropic.", api_type
            )
            return ("anthropic", {})
        return None

    # Guard 3 + 4 -- registry lookup + base_url marker match.
    base_url = str(active_llm.get("base_url") or "").strip().lower()
    for candidate in candidates:
        registration = provider_registry.find(candidate)
        if registration is None:
            continue

        # Skip plugin packages (handled by the plugin loop earlier).
        if registration.source != SOURCE_BUILTIN:
            continue
        if "custom_plugin" in (registration.class_path or ""):
            continue

        # Skip legacy wrappers (openai_compat, lmstudio, ollama legacy).
        adapter_class = registration.adapter_class
        adapter_style = getattr(adapter_class, "ADAPTER_STYLE", "legacy")

        # [M7.3 FIX] If a legacy adapter is matched, automatically check
        # for its native equivalent (e.g., "lmstudio" -> "lmstudio_native").
        if adapter_style != "v1":
            native_reg = provider_registry.find(f"{candidate}_native")
            if native_reg is not None:
                registration = native_reg
                adapter_class = registration.adapter_class
                adapter_style = getattr(adapter_class, "ADAPTER_STYLE", "legacy")

        if adapter_style != "v1":
            continue

        # Read the markers from the adapter's own PROFILE.
        profile = getattr(adapter_class, "PROFILE", None)
        markers: List[str] = []
        if profile is not None:
            raw_markers = getattr(profile, "default_base_url_markers", None)
            if isinstance(raw_markers, list):
                markers = [
                    str(m).strip().lower()
                    for m in raw_markers
                    if isinstance(m, str) and str(m).strip()
                ]

        # Empty base_url -> use the provider's default endpoint -> Native.
        if not base_url:
            logger.info(
                "[BRIDGE] Provider %r → native adapter %r "
                "(default endpoint).",
                candidate,
                registration.provider_id,
            )
            return (registration.provider_id, {})

        # Marker match -> Native Adapter.
        if markers and any(m in base_url for m in markers):
            logger.info(
                "[BRIDGE] Provider %r → native adapter %r "
                "(base_url marker match: %r).",
                candidate,
                registration.provider_id,
                active_llm.get("base_url"),
            )
            return (registration.provider_id, {})

        # No marker match -> the user is pointing the provider at a
        # custom proxy. Respect that choice: use openai_compat.
        logger.info(
            "[BRIDGE] Provider %r has custom base_url %r — "
            "using openai_compat (respecting user's proxy choice).",
            candidate,
            active_llm.get("base_url"),
        )
        return None

    # No candidate matched any registered native adapter. This is the
    # normal path for Custom Endpoints and unknown providers.
    logger.debug(
        "[BRIDGE] No native adapter for candidates=%r. "
        "Using openai_compat.",
        candidates,
    )
    return None


def resolve_provider_and_extras(
    active_llm: Dict[str, Any],
    *,
    connection_id: str,
) -> Tuple[str, Dict[str, Any]]:
    """
    Resolve the adapter provider_id and extra_params for an LLM request.

    Priority
    --------
    1. If the active provider is an installed Provider Package
       (registered with SOURCE_EXTERNAL and served by
       PluginProviderAdapter), return its canonical ID and the
       plugin descriptor in extra_params.
    2. Otherwise, try Built-in Native Adapter routing (M7.3).
    3. Otherwise, return ("openai_compat", {}) -- preserving the
       legacy behavior where every provider used the
       OpenAI-compatible adapter.

    The descriptor travels inside ``ConnectionContext.extra_params``
    so that ``peldrun.llm`` never needs to import
    ``omweb.provider_packages`` -- preserving the architectural
    boundary (see contracts.py for the rationale).

    Parameters
    ----------
    active_llm
        The merged LLM configuration dict (post-``llm_override``).
        Reads ``provider``, ``provider_name``, and ``base_url``.
    connection_id
        Connection identifier (typically the job_id in the bridge).
        Used in logging and passed to the descriptor builder.

    Returns
    -------
    tuple[str, Dict[str, Any]]
        ``(provider_id, extra_params)``. ``extra_params`` is empty
        for the built-in fallback and native paths, and contains
        ``PLUGIN_DESCRIPTOR_KEY`` for plugin providers.
    """
    # ------------------------------------------------------------------
    # 1. Collect candidate provider IDs from active_llm.
    # ------------------------------------------------------------------
    candidates: List[str] = []
    seen_candidates: set = set()

    def _push_candidate(value: Any) -> None:
        if not isinstance(value, str):
            return
        normalized = value.strip().lower()
        if not normalized or normalized in seen_candidates:
            return
        seen_candidates.add(normalized)
        candidates.append(normalized)

    _push_candidate(active_llm.get("provider"))
    _push_candidate(active_llm.get("provider_name"))

    # NOTE: We deliberately do NOT infer the provider from `base_url`
    # or port numbers. The vault (`models_vault.json`) is the single
    # source of truth for `provider` and `provider_name`. Any Custom
    # Endpoint that does not match a registered built-in provider ID
    # will safely fall through to `openai_compat`.
    if not candidates:
        return ("openai_compat", {})

    # ------------------------------------------------------------------
    # 2. Try to resolve each candidate against the provider registry.
    #
    # Lazy imports: the dispatcher package is imported very early in
    # the backend startup sequence, and provider_registry triggers a
    # module-level bootstrap that is expensive. Deferring the import
    # until the first LLM request keeps backend startup fast.
    # ------------------------------------------------------------------
    try:
        from peldrun.llm.providers.registry import (
            SOURCE_EXTERNAL,
            provider_registry,
        )
    except Exception as exc:
        logger.debug(
            "[BRIDGE] provider_registry import failed for %r: %s",
            connection_id,
            exc,
        )
        return ("openai_compat", {})

    for candidate in candidates:
        registration = provider_registry.find(candidate)
        if registration is None:
            continue

        # Only plugin providers qualify for plugin routing.
        # Built-in native adapters (anthropic, google_genai, etc.)
        # are handled by the M7.3 block after this loop.
        if registration.source != SOURCE_EXTERNAL:
            continue
        if "custom_plugin" not in (registration.class_path or ""):
            continue

        descriptor_dict = build_plugin_descriptor_dict(
            registration.provider_id, connection_id=connection_id
        )
        if descriptor_dict is None:
            logger.warning(
                "[BRIDGE] Plugin provider %r is registered but its "
                "descriptor could not be built (connection_id=%r). "
                "Falling back to openai_compat; the request may fail "
                "if the endpoint is not OpenAI-compatible.",
                registration.provider_id,
                connection_id,
            )
            continue

        # ------------------------------------------------------------------
        # Load the active connection for this package.
        #
        # A package must have at least one CONFIGURED connection (set by
        # the user via Store -> Providers -> Configure) before it can be
        # dispatched. Without one, the adapter has no endpoint, no API
        # key, and no per-package extra fields -- it cannot work.
        #
        # If no active connection exists, we fall back to ``openai_compat``
        # so the request fails in a way the user recognizes ("this
        # endpoint doesn't speak OpenAI") instead of failing with a
        # cryptic "adapter has no base_url" error from inside the plugin
        # worker.
        # ------------------------------------------------------------------
        try:
            from omweb.routers.config_rtr import (
                get_active_connection_for_package,
            )
            active_conn = get_active_connection_for_package(
                registration.provider_id
            )
        except Exception as conn_err:
            logger.warning(
                "[BRIDGE] Could not read provider connections for %r: %s. "
                "Falling back to openai_compat.",
                registration.provider_id,
                conn_err,
            )
            active_conn = None

        if not active_conn:
            logger.warning(
                "[BRIDGE] Package %r is registered but has NO active "
                "connection. Configure it in Store → Providers first. "
                "Falling back to openai_compat for this request.",
                registration.provider_id,
            )
            continue

        # ------------------------------------------------------------------
        # Build the effective connection data.
        #
        # Convention (matches the reference packages in the catalog):
        #   * ``base_url``  -- the connection's endpoint URL
        #   * ``api_key``   -- the connection's authentication secret
        #
        # Every OTHER field (``scope``, ``anthropic_version``,
        # ``folder_id``, ``ca_bundle_file``, ...) is passed through
        # ``extra_params`` so the adapter's Python code can read it via
        # ``context.extra_params[<key>]``.
        # ------------------------------------------------------------------
        conn_fields = dict(active_conn.get("fields") or {})

        # ------------------------------------------------------------------
        # Inject installed certificate paths into file-typed fields.
        #
        # This is the SAME injection that `providers.py::test_connection`
        # performs. Without it, chat and agent dispatch receive an EMPTY
        # `ca_bundle_path` (the vault stores `""` by default -- the
        # Certificate Manager populates it only during test runs via
        # `_inject_installed_certificates`). The adapter then falls back
        # to certifi -- which does NOT contain the Russian Root CA -- and
        # the OAuth call fails with:
        #
        #   [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed:
        #   self-signed certificate in certificate chain
        #
        # Real-world symptom observed before this fix:
        #   * Test Connection:    works (providers.py injects certs)
        #   * Chat / Agent mode:  SSL error (dispatcher did NOT inject)
        #
        # Reusing `_inject_installed_certificates` guarantees both paths
        # produce byte-identical `ConnectionContext.extra_params`.
        # ------------------------------------------------------------------
        try:
            from omweb.routers.store.providers import (
                _inject_installed_certificates,
                _try_read_manifest,
            )
            from omweb.provider_packages.package_manager import (
                provider_package_manager as _ppm,
            )
            _pkg_entry = _ppm.get_package(registration.provider_id)
            if _pkg_entry is not None:
                _manifest = _try_read_manifest(
                    registration.provider_id,
                    _pkg_entry.active_version,
                )
                conn_fields = _inject_installed_certificates(
                    registration.provider_id,
                    conn_fields,
                    _manifest,
                )
                if conn_fields.get("ca_bundle_path"):
                    logger.info(
                        "[BRIDGE] Injected ca_bundle_path for plugin "
                        "%r: %s",
                        registration.provider_id,
                        conn_fields["ca_bundle_path"],
                    )
        except Exception as _inject_err:
            # Non-fatal: a package without certificates works fine
            # without injection. Packages that REQUIRE a CA bundle
            # surface a clear SSL error at request time -- same as
            # the pre-fix behavior.
            logger.debug(
                "[BRIDGE] Certificate injection failed for %r: %s",
                registration.provider_id,
                _inject_err,
            )

        base_url_override = str(
            conn_fields.get("base_url") or ""
        ).strip() or None
        api_key_override = str(
            conn_fields.get("api_key") or ""
        ).strip() or None

        extra_params: Dict[str, Any] = {
            PLUGIN_DESCRIPTOR_KEY: descriptor_dict,
        }
        for field_key, field_val in conn_fields.items():
            if field_key in ("base_url", "api_key"):
                continue
            extra_params[field_key] = field_val

        # Reserved overrides: popped by the call site before building
        # the ConnectionContext. The leading underscore marks them as
        # peldrun-internal -- adapters never see them.
        extra_params["_peldrun_base_url"] = base_url_override
        extra_params["_peldrun_api_key"] = api_key_override
        extra_params["_peldrun_connection_id"] = active_conn.get("id")

        logger.info(
            "[BRIDGE] Routing %r through package %r (connection=%r, "
            "transport=%s, extra_fields=%s).",
            connection_id,
            registration.provider_id,
            active_conn.get("name"),
            descriptor_dict.get("transport", "?"),
            [
                k for k in conn_fields.keys()
                if k not in ("base_url", "api_key")
            ],
        )
        return (registration.provider_id, extra_params)

    # ------------------------------------------------------------------
    # [M7.3] Native Adapter routing (data-driven, no hard-coding).
    #
    # Runs AFTER the plugin loop, so a Store-installed Provider Package
    # always wins over a built-in name collision (they cannot collide
    # anyway -- the registry protects built-ins -- but this ordering
    # documents the priority).
    #
    # If resolve_native_adapter returns None, openai_compat is used.
    # That fallback covers: Custom Endpoints, missing SDKs, custom
    # proxy URLs, api_type="chat_completions", and
    # use_native_adapters=false.
    # ------------------------------------------------------------------
    native_result = resolve_native_adapter(active_llm, candidates)
    if native_result is not None:
        logger.debug(
            "[BRIDGE] _resolve_provider_and_extras -> %r",
            native_result[0],
        )
        return native_result

    logger.debug("[BRIDGE] _resolve_provider_and_extras -> 'openai_compat'")
    return ("openai_compat", {})


def build_plugin_descriptor_dict(
    provider_id: str,
    *,
    connection_id: str,
) -> Optional[Dict[str, Any]]:
    """
    Build the plugin descriptor dict for the given `provider_id`.

    Reads the installed package via ``provider_package_manager`` and
    returns the descriptor in the exact shape expected by
    ``PluginProviderAdapter._extract_descriptor`` (matching the
    structure produced by
    ``custom_plugin.ensure_plugin_providers_registered``).

    Returns ``None`` when the package is not installed, not enabled,
    or the active version's files are missing from disk. In every
    failure case the caller falls back to ``openai_compat``.
    """
    try:
        from omweb.provider_packages.package_manager import (
            provider_package_manager,
        )
    except Exception as exc:
        logger.debug(
            "[BRIDGE] provider_package_manager import failed for %r: %s",
            provider_id,
            exc,
        )
        return None

    try:
        descriptor_obj = (
            provider_package_manager.get_active_adapter_descriptor(provider_id)
        )
    except Exception as exc:
        logger.debug(
            "[BRIDGE] get_active_adapter_descriptor(%r) failed: %s",
            provider_id,
            exc,
        )
        return None

    if descriptor_obj is None:
        logger.debug(
            "[BRIDGE] No active adapter descriptor for plugin %r "
            "(package not installed, disabled, or files missing). "
            "connection_id=%r",
            provider_id,
            connection_id,
        )
        return None

    # Best-effort lookup for the display name (used only in logs).
    display_name: str = provider_id
    try:
        pkg_entry = provider_package_manager.get_package(provider_id)
        if pkg_entry is not None:
            display_name = (
                pkg_entry.display_name or pkg_entry.name or pkg_entry.id
            )
    except Exception:
        pass

    return {
        "provider_id": descriptor_obj.provider_id,
        "version": descriptor_obj.version,
        "transport": descriptor_obj.transport,
        "api_contract": descriptor_obj.api_contract,
        "entry_point": descriptor_obj.entry_point,
        "class_name": descriptor_obj.class_name,
        "base_adapter": descriptor_obj.base_adapter,
        "package_dir": str(descriptor_obj.package_dir),
        "venv_python": (
            str(descriptor_obj.venv_python)
            if descriptor_obj.venv_python is not None
            else None
        ),
        "features": dict(descriptor_obj.features or {}),
        "permissions": dict(descriptor_obj.permissions or {}),
        "display_name": display_name,
    }


__all__ = [
    "native_adapters_enabled",
    "resolve_native_adapter",
    "resolve_provider_and_extras",
    "build_plugin_descriptor_dict",
]

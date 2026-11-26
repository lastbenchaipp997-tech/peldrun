# backend/omweb/agent_bridge_parts/dispatcher/agent_routing.py
"""
Agent-mode provider routing: publish the routing decision into active_llm.

Extracted verbatim from the [M9] block of ``run_instrumented``. AGENT-ONLY.

WHY THIS IS NOT SHARED WITH CHAT
--------------------------------
Both modes call the same ``provider_routing.resolve_provider_and_extras``,
but they CONSUME the result differently:

  Agent: writes four reserved keys INTO ``active_llm``. The executor in
         ``peldrun.runtime`` reads them as plain data and builds the
         ConnectionContext itself. This keeps the architectural boundary:
         peldrun.runtime never imports omweb.
  Chat : pops the overrides and builds ``ConnectionContext`` directly,
         applying ``or base_url`` / ``or api_key`` fallbacks.

Two consequences that must not be "unified":

  * Agent stores ``_peldrun_base_url`` / ``_peldrun_api_key`` even when they
    are None. Chat substitutes its own values instead. Adding a fallback
    here would change what the executor sends.
  * Agent discards ``_peldrun_connection_id``; it is not forwarded.

GATE CONDITION
--------------
``provider_id != "openai_compat"`` is the ONLY condition. An earlier version
also required truthy ``extra_params``, which silently excluded Native
Adapters -- they return ``{}`` by design. Do not reintroduce that clause.

PRESERVED LABELING QUIRK
------------------------
The INFO log says "Routing to plugin provider" for Native Adapters too, and
their transport reads "unknown" because they carry no plugin descriptor.
This is pre-existing log text; changing it would break log-based monitoring.
Chat mode distinguishes plugin vs native in its own log -- agent does not.

FAILURE SEMANTICS
-----------------
Never raises. A resolution failure leaves the reserved keys absent, so the
executor falls back to ``openai_compat`` -- identical to a deployment with
no Provider Package installed.
"""
from __future__ import annotations

import logging
from typing import Any, Dict

from peldrun.llm.providers.custom_plugin import PLUGIN_DESCRIPTOR_KEY

from .provider_routing import resolve_provider_and_extras

logger = logging.getLogger(__name__)


def apply_agent_provider_routing(
    active_llm: Dict[str, Any],
    job_id: str,
) -> None:
    """
    Resolve routing and publish the reserved keys into ``active_llm``.

    Mutates in place, returns None, never raises.
    """
    try:
        _plugin_provider_id, _plugin_extra_params = resolve_provider_and_extras(
            active_llm,
            connection_id=job_id,
        )
        # Single gate: any non-compat provider (plugin OR native) publishes
        # the reserved keys. See the module docstring.
        if _plugin_provider_id != "openai_compat":
            _base_url_override = _plugin_extra_params.pop(
                "_peldrun_base_url", None
            )
            _api_key_override = _plugin_extra_params.pop(
                "_peldrun_api_key", None
            )
            _plugin_extra_params.pop("_peldrun_connection_id", None)

            active_llm["_peldrun_provider_id"] = _plugin_provider_id
            active_llm["_peldrun_extra_params"] = _plugin_extra_params
            active_llm["_peldrun_base_url"] = _base_url_override
            active_llm["_peldrun_api_key"] = _api_key_override

            _desc = _plugin_extra_params.get(PLUGIN_DESCRIPTOR_KEY, {})
            logger.info(
                "[BRIDGE AGENT] Routing to plugin provider %r "
                "(transport=%s) for job %s.",
                _plugin_provider_id,
                _desc.get("transport", "unknown"),
                job_id,
            )
    except Exception as _plugin_resolve_err:
        logger.warning(
            "[BRIDGE AGENT] Plugin provider resolution failed for job "
            "%s (falling back to openai_compat): %s",
            job_id,
            _plugin_resolve_err,
        )


__all__ = ["apply_agent_provider_routing"]

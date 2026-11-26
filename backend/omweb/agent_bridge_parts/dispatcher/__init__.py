# backend/omweb/agent_bridge_parts/dispatcher/__init__.py
"""
Public facade for the PELDRUN Universal Agent Bridge dispatcher package.

MIGRATION STATE -- STRANGLER FIG, STEP 4
----------------------------------------
Migrated : model fact resolution -> .model_resolution
           provider routing      -> .provider_routing
           engine policy         -> .engine_policy
           resource monitor      -> .monitor_hooks
           chat prompting        -> .chat_prompting
           image results         -> .image_results
           session logging       -> .session_log
Pending  : dispatch entry points, diagnostics
           (still served by .._dispatcher_legacy)

SHARED MODULES (intentionally NOT re-exported)
----------------------------------------------
``.workspace`` and ``.llm_runtime_config`` are new shared helpers
extracted from code that was INLINED and DUPLICATED inside
``run_instrumented`` and ``run_direct_chat``. They have no historical
module-level name, so there is nothing to re-export and nothing to
switch. They go live when the dispatch entry points are extracted;
until then the legacy function bodies keep their own inline copies.

``llm_runtime_config`` preserves the agent/chat ASYMMETRY: reasoning
effort normalization and the vault base_url override are AGENT-ONLY
calls and must never be added to the chat path.
The original monolithic ``agent_bridge_parts/dispatcher.py`` was moved
VERBATIM to ``agent_bridge_parts/_dispatcher_legacy.py``. It was kept at
the SAME package depth on purpose:

  * Its legacy storage fallbacks compute ``module_dir.parent.parent``,
    which must resolve to the ``backend`` directory. Moving it one level
    deeper (into this package) would silently redirect those reads to
    ``backend/omweb/storage``.
  * Its relative imports (``.config_loader``, ``.state``, ``.errors``,
    ``.lmstudio``, ``.mention_resolver``) resolve against
    ``agent_bridge_parts``. Moving it into this package would break all
    of them.

This facade preserves the historical public import path exactly:

    from omweb.agent_bridge_parts.dispatcher import run_instrumented

Nothing in this file adds behavior. Every name below is a straight
re-export, including the private helpers, so any external module or
test that reached into ``dispatcher._some_helper`` keeps working.

MIGRATION CONTRACT
------------------
As each extracted module lands, its group below is re-pointed from
``.._dispatcher_legacy`` to the new sibling module. Two rules apply to
every such switch:

  1. The exported NAME never changes (private aliases included).
  2. The extracted implementation must be behavior-identical, verified
     by a parity check against ``_dispatcher_legacy`` before switching.

The legacy module is deleted only after every group has been migrated
and the parity checks pass.

NOTE ON MONKEYPATCHING
----------------------
Re-exporting a name binds it HERE. Patching
``omweb.agent_bridge_parts.dispatcher._resolve_provider_and_extras``
therefore replaces the facade attribute only -- internal call sites
inside ``_dispatcher_legacy`` (and, later, inside the extracted
modules) still use their own module-global binding. This is identical
to the pre-split situation for cross-module patching, but if a test
patches a dispatcher-private helper expecting an internal effect, it
must target the OWNING module instead. Each group comment below names
that owner.
"""
from __future__ import annotations

import logging

# ---------------------------------------------------------------------------
# Group: engine policy
# Owner : .engine_policy   [MIGRATED]
#
# Parity verified BEFORE this switch: 22 inputs covering empty/whitespace,
# every alias, every legacy id, mixed casing, unknown ids, and non-string
# falsy values (0, False, [], {}). Both return values AND exception
# type/message were compared. Constant values AND types also match.
#
# Error messages are user-visible (forwarded into the ERROR SSE payload)
# and are reproduced byte-for-byte, including the interpolation of the
# ORIGINAL value rather than the normalized id.
# ---------------------------------------------------------------------------
from .engine_policy import (
    LEGACY_ENGINE_IDS,
    SUPPORTED_ENGINE,
    VALID_CORE_ALIASES,
    validate_requested_engine,
)

# ---------------------------------------------------------------------------
# Group: resource monitor hooks
# Owner : .monitor_hooks   [MIGRATED]
#
# These are called from terminal paths, including inside except/finally
# blocks. They MUST never raise: a raising monitor hook would mask the
# real provider error or abort cleanup and strand the job in "running".
# The extracted module keeps the lazy service import, the blanket
# exception swallow, the DEBUG-only log level, and the keyword form of
# ``error_message``.
# ---------------------------------------------------------------------------
from .monitor_hooks import (
    safe_monitor_cancel_run as _safe_monitor_cancel_run,
    safe_monitor_complete_run as _safe_monitor_complete_run,
    safe_monitor_fail_run as _safe_monitor_fail_run,
    safe_monitor_start_run as _safe_monitor_start_run,
)

# ---------------------------------------------------------------------------
# Group: model fact resolution
# Owner : .model_resolution   [MIGRATED]
#
# Parity against .._dispatcher_legacy was verified BEFORE this switch
# (context window / max output tokens / temperature / reasoning flag
# over representative model ids -> identical results).
#
# The extracted module exposes PUBLIC names. The historical PRIVATE
# names are aliased here so every existing importer keeps working
# unchanged, e.g.:
#
#   from omweb.agent_bridge_parts.dispatcher import _is_reasoning_model
#
# PATCH TARGET NOTICE
# -------------------
# ``_dispatcher_legacy`` still calls its OWN module-global copies of
# these helpers. Rebinding the facade attribute therefore does NOT
# affect legacy call sites. To alter behavior inside the legacy
# dispatcher, patch ``omweb.agent_bridge_parts._dispatcher_legacy``.
# Once the dispatch entry points are extracted they will import from
# ``.model_resolution`` directly, and patching THAT module will take
# effect for them. This split-brain window is inherent to the
# strangler-fig migration and closes when the legacy module is removed.
# ---------------------------------------------------------------------------
from .model_resolution import (
    check_adapter_reasoning_opinion as _check_adapter_reasoning_opinion,
    check_manual_reasoning_override as _check_manual_reasoning_override,
    check_model_metadata_reasoning as _check_model_metadata_reasoning,
    is_reasoning_model as _is_reasoning_model,
    read_model_metadata_entry as _read_model_metadata_entry,
    resolve_model_context_window as _resolve_model_context_window,
    resolve_model_max_output_tokens as _resolve_model_max_output_tokens,
    resolve_model_temperature as _resolve_model_temperature,
)

# ---------------------------------------------------------------------------
# Group: provider routing (native adapters + provider packages)
# Owner : .provider_routing   [MIGRATED]
#
# Parity against .._dispatcher_legacy was verified BEFORE this switch:
#   * resolve_provider_and_extras across 9 representative configs
#     (empty / openai / lmstudio+local url / anthropic+chat_completions /
#      openai+responses / google+marker url / native disabled /
#      provider_name only / unknown provider) -> identical tuples.
#   * native_adapters_enabled across 10 flag shapes -> identical bools.
#
# Precedence preserved verbatim: the plugin-package loop runs BEFORE
# the native-adapter lookup, so a Store-installed package always wins
# a name collision. Reordering these would silently change which
# adapter executes a request.
#
# PATCH TARGET NOTICE: same split-brain window documented in the model
# resolution group above. ``_dispatcher_legacy`` still calls its own
# module-global copies, so patching the facade does not affect legacy
# runs. The window closes when the dispatch entry points are extracted.
# ---------------------------------------------------------------------------
from .provider_routing import (
    build_plugin_descriptor_dict as _build_plugin_descriptor_dict,
    native_adapters_enabled as _native_adapters_enabled,
    resolve_native_adapter as _resolve_native_adapter,
    resolve_provider_and_extras as _resolve_provider_and_extras,
)

# ---------------------------------------------------------------------------
# Group: chat prompting
# Owner : .chat_prompting   [MIGRATED]
#
# CHAT-ONLY persona contract. Agent mode takes its system prompt from the
# agent manifest, never from here.
#
# The four prompt strings are model-visible behavior and are reproduced
# byte-for-byte, including their original phrasing. The resolver is
# contractually guaranteed to return a non-empty string, which is why
# build_optimized_chat_messages appends the system role unconditionally.
#
# This module imports ``.model_resolution`` directly (not the facade), so
# it always uses the migrated reasoning resolver.
# ---------------------------------------------------------------------------
from .chat_prompting import (
    build_optimized_chat_messages as _build_optimized_chat_messages,
    resolve_chat_system_prompt as _resolve_chat_system_prompt,
)

# ---------------------------------------------------------------------------
# Group: session logging
# Owner : .session_log   [MIGRATED]
#
# Byte-exact format contract:
#   [<YYYY-MM-DD HH:MM:SS>] [<TYPE_UPPER>] <single-line message>\n
# CRLF is collapsed to ONE space before LF is collapsed to ONE space.
# Both the order and the single-space replacement are load-bearing for
# existing chat.log files and any downstream parser.
#
# Writes to BOTH the project-scoped chat dir and the legacy chats_dir,
# each with its own try/except. Never raises.
# ---------------------------------------------------------------------------
from .session_log import append_session_log as _append_session_log

# ---------------------------------------------------------------------------
# Group: image results (chat-mode SSE emission)
# Owner : .image_results   [MIGRATED]
#
# Single emission point for chat-mode image results. Agent mode emits the
# equivalent event from peldrun_engine.py.
#
# ``build_proxy_url`` stays a lazy in-function import, positioned BEFORE
# the payload check, to preserve both the import-cycle break and the
# original failure ordering.
#
# Multimodal attachment injection is NOT here yet: it is still inline
# inside the legacy run_direct_chat and will be extracted together with
# the chat dispatch entry point.
# ---------------------------------------------------------------------------
from .image_results import (
    emit_image_results_event_if_present as _emit_image_results_event_if_present,
)

# ---------------------------------------------------------------------------
# Group: dispatch entry points
# Owner : .agent_dispatch / .chat_dispatch   [MIGRATED]
#
# Both orchestrators are THIN: every decision lives in a sibling module
# that was parity-verified against the legacy implementation before the
# switch. Nothing here computes anything new.
#
# PRESERVED MODE ASYMMETRIES (must never be unified)
# --------------------------------------------------
#   * normalize_reasoning_effort + vault base_url override -> AGENT ONLY
#   * api_key default: agent "" / chat "EMPTY"
#   * reference injection: agent always / chat only with composer refs
#   * memory retrieval failure: agent WARNING + counter / chat DEBUG only
#   * abort cleanup: setup and readiness clean up THEMSELVES; the chat
#     web-search abort relies on the caller's finally
#
# NO module in this package imports .._dispatcher_legacy any more.
# ---------------------------------------------------------------------------
from .agent_dispatch import run_instrumented
from .chat_dispatch import run_direct_chat

# ---------------------------------------------------------------------------
# Group: diagnostics
#
# ``__name__`` here is ``omweb.agent_bridge_parts.dispatcher`` -- the SAME
# logger name the original monolithic dispatcher.py used before the split.
# Every extracted module's logger (``...dispatcher.provider_routing``,
# ``...dispatcher.session_log``, ...) is a CHILD of this one in the logging
# hierarchy, so any handler / level / filter configured on the historical
# name keeps working through normal propagation. No log-routing change.
# ---------------------------------------------------------------------------
logger = logging.getLogger(__name__)

# Public surface -- identical to the original dispatcher.__all__.
__all__ = [
    "run_instrumented",
    "run_direct_chat",
    "validate_requested_engine",
]

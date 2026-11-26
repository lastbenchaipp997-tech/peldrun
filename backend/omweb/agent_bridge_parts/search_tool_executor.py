# backend/omweb/agent_bridge_parts/search_tool_executor.py
"""
Search Tool Executor — LLM-driven search routing for chat mode.

Replaces all intent-detection logic (regex, keyword tables) with a
direct LLM tool-choice mechanism: when the user activates the search
button, both ``web_search`` and ``image_search`` are offered to the
LLM, which selects the appropriate tool and provides the search query.
The chosen tool is executed and its result returned to the caller.

Design
------
    * No regex.
    * No keyword tables.
    * No language-specific logic.
    * The LLM — which is already multilingual and context-aware —
      makes the routing decision.

    The executor makes ONE short, non-streaming routing call with
    ``tool_choice="required"``. This guarantees the LLM picks a tool
    rather than answering in prose, while keeping the call cheap
    (~150 tokens in, ~30 tokens out).

    The caller (dispatcher) remains responsible for augmenting the
    prompt with the search result and for dispatching the final
    user-facing LLM call — the executor never owns user-facing
    generation.

Public API
----------
    async def execute_search_via_llm_choice(
        prompt: str,
        *,
        provider_id: str,
        base_url: str,
        api_key: str,
        model_name: str,
        connection_id: str,
        workspace_dir: Path,
        run_id: str,
        job_id: str,
        chat_id: str,
        project_id: str,
        timeout_seconds: float = 30.0,
        extra_params: Optional[Dict[str, Any]] = None,
    ) -> tuple[Optional[ToolResult], Optional[str]]:
        ...
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
import re
from typing import Any, Dict, List, Optional, Tuple


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# OpenAI-compatible function schemas for the two search tools.
#
# These are the tool descriptors the LLM sees. The descriptions are
# deliberately concise and unambiguous so the routing decision is
# deterministic and language-agnostic: the LLM matches the USER'S
# intent against the tool's PURPOSE, not against specific words.
# ---------------------------------------------------------------------------
_WEB_SEARCH_SCHEMA: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": (
            "Search the web for textual information: news, articles, "
            "documentation, facts, definitions, tutorials, or any "
            "text-based content. Returns titles, snippets, and URLs. "
            "Use this when the user wants to READ, LEARN, or VERIFY "
            "something."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "The search query, in the same language as the "
                        "user's request."
                    ),
                },
            },
            "required": ["query"],
        },
    },
}

_IMAGE_SEARCH_SCHEMA: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "image_search",
        "description": (
            "Search the web for images, pictures, photos, or "
            "photographs. Returns direct image URLs with thumbnails, "
            "source pages, and dimensions. Use this when the user "
            "wants to SEE, VIEW, DOWNLOAD, or FIND pictures of "
            "something."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "The subject to search images for, in the same "
                        "language as the user's request. Extract just "
                        "the subject (e.g. 'cats' or 'Paris at night'), "
                        "not the full sentence."
                    ),
                },
            },
            "required": ["query"],
        },
    },
}


_ROUTING_SYSTEM_PROMPT = (
    "You are a search-tool router. Based on the user's request, call "
    "EXACTLY ONE of the available tools:\n"
    "- Use 'image_search' when the user wants to see, view, find, "
    "download, or look at pictures, images, photos, or photographs.\n"
    "- Use 'web_search' for any other request that needs web "
    "information (news, facts, articles, documentation, tutorials, "
    "definitions, etc.).\n\n"
    "Extract a clean search query from the user's request — do not "
    "pass the entire conversational message. Preserve the original "
    "language of the request."
)


def _extract_tool_call_from_content(
    content: str,
) -> Optional[Tuple[str, str, Dict[str, Any]]]:
    """
    Fallback extractor for models that emit tool calls as JSON text
    instead of using the native function-calling interface.

    Many small/local models (Nemotron, Qwen 2.5-7B, Llama 3.2-3B,
    DeepSeek-Lite, etc.) and LM Studio backends do not honor
    ``tool_choice`` strictly: they write the intended tool call as
    JSON inside ``response.content`` rather than populating
    ``response.tool_calls``.

    This helper recovers the decision from those models without
    introducing any intent-detection heuristics. The LLM still makes
    the routing choice — this function only parses how that choice
    is expressed.

    Accepted JSON shapes (all common in the wild):

        {"tool": "image_search", "query": "..."}
        {"name": "image_search", "arguments": {"query": "..."}}
        {"name": "image_search", "query": "..."}
        {"function": {"name": "image_search", "arguments": "..."}}
        {"function": {"name": "image_search", "arguments": {...}}}

    Returns
    -------
    (tool_name, query, extra_args) or None
        ``tool_name`` is ``"web_search"`` or ``"image_search"``.
        ``query`` is non-empty.
        ``extra_args`` is the full argument dict the LLM provided.
    """
    if not content or not isinstance(content, str):
        return None

    text = content.strip()
    if not text:
        return None

    # Collect candidate JSON substrings in priority order.
    # We try the whole string first (the cleanest shape), then any
    # embedded {...} block, then every line that looks like JSON.
    candidates: List[str] = [text]

    # Fenced code block (e.g. ```json\n{...}\n```)
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        candidates.append(fenced.group(1))

    # Greedy braces match — captures the outermost JSON object.
    # DOTALL is required because some models pretty-print the JSON.
    braces = re.search(r"\{.*\}", text, re.DOTALL)
    if braces and braces.group(0) not in candidates:
        candidates.append(braces.group(0))

    # Per-line scan — catches cases where JSON is the last line
    # after explanation text.
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("{") and stripped.endswith("}"):
            if stripped not in candidates:
                candidates.append(stripped)

    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            continue
        if not isinstance(parsed, dict):
            continue

        tool_name: Optional[str] = None
        args: Dict[str, Any] = {}

        # Shape A — {"tool": "...", "query": "..."}
        raw_tool = parsed.get("tool")
        if isinstance(raw_tool, str) and raw_tool.strip():
            tool_name = raw_tool.strip()
            for k, v in parsed.items():
                if k in ("tool", "name", "function"):
                    continue
                args[k] = v

        # Shape B — {"name": "...", "arguments": {...}} or
        #           {"name": "...", "query": "..."}
        elif isinstance(parsed.get("name"), str) and parsed["name"].strip():
            tool_name = parsed["name"].strip()
            raw_args = parsed.get("arguments")
            if isinstance(raw_args, dict):
                args = dict(raw_args)
            elif isinstance(raw_args, str) and raw_args.strip():
                try:
                    parsed_args = json.loads(raw_args)
                    if isinstance(parsed_args, dict):
                        args = parsed_args
                except (json.JSONDecodeError, ValueError):
                    pass
            if "query" in parsed and "query" not in args:
                args["query"] = parsed["query"]

        # Shape C — {"function": {"name": "...", "arguments": "..."}}
        elif isinstance(parsed.get("function"), dict):
            fn = parsed["function"]
            if isinstance(fn.get("name"), str) and fn["name"].strip():
                tool_name = fn["name"].strip()
            raw_args = fn.get("arguments")
            if isinstance(raw_args, dict):
                args = dict(raw_args)
            elif isinstance(raw_args, str) and raw_args.strip():
                try:
                    parsed_args = json.loads(raw_args)
                    if isinstance(parsed_args, dict):
                        args = parsed_args
                except (json.JSONDecodeError, ValueError):
                    pass

        if not tool_name:
            continue
        # Only the two tools offered in the routing call are valid.
        if tool_name not in ("web_search", "image_search"):
            continue

        query = str(args.get("query") or "").strip()
        if not query:
            continue

        return (tool_name, query, args)

    return None


async def execute_search_via_llm_choice(
    prompt: str,
    *,
    provider_id: str,
    base_url: str,
    api_key: str,
    model_name: str,
    connection_id: str,
    workspace_dir: Path,
    run_id: str,
    job_id: str,
    chat_id: str,
    project_id: str,
    timeout_seconds: float = 30.0,
    extra_params: Optional[Dict[str, Any]] = None,
) -> Tuple[Optional[Any], Optional[str]]:
    """
    Let the LLM choose which search tool to invoke, then execute it.

    Returns
    -------
    (result, tool_name)
        ``result`` is the ToolResult returned by the chosen tool, or
        ``None`` if the routing call or tool execution failed.
        ``tool_name`` is ``"web_search"``, ``"image_search"``, or
        ``None`` on failure.

    Failure modes
    -------------
    Every failure returns ``(None, None)`` — the caller decides whether
    to fail the job or fall back to a text-only response. Failures are
    logged at WARNING level with enough context for diagnosis.
    """
    # Local imports to avoid a module-load cycle at dispatcher import
    # time (dispatcher imports this module lazily inside the search
    # block).
    from peldrun.llm.contracts import ConnectionContext
    from peldrun.llm.providers import provider_factory
    from peldrun.llm.request import (
        GenerationConfig,
        LLMRequest,
        ResponseFormat,
        ToolChoiceSpec,
    )
    from peldrun.tools.builtins.image_search import ImageSearchTool
    from peldrun.tools.builtins.web_search import WebSearchTool

    if not prompt or not prompt.strip():
        logger.warning(
            "[SEARCH-EXEC] Empty prompt — no search executed "
            "(job=%s).",
            job_id,
        )
        return (None, None)

    # ------------------------------------------------------------------
    # 1. Create a short-lived adapter for the routing call.
    #
    # This adapter is created with the SAME provider configuration
    # the main completion will use, guaranteeing consistent routing
    # behavior. It is closed in the finally block below — the main
    # completion creates its own adapter later in the flow.
    #
    # ``extra_params`` parity note
    # ----------------------------
    # The main completion path in ``dispatcher.run_direct_chat``
    # constructs ``ConnectionContext`` with ``extra_params=
    # adapter_extra_params``, which for native adapters is ``{}``
    # (empty dict). Some native adapters (deepseek_native in
    # particular) branch on the presence of ``extra_params``: when
    # it is ``None``, they fall back to a hardcoded default URL
    # instead of ``connection.base_url``. That divergence caused the
    # routing call to resolve a different (unreachable) host than
    # the main call, producing ``getaddrinfo failed``.
    #
    # Passing the caller-supplied ``extra_params`` — and defaulting
    # to ``{}`` rather than ``None`` — keeps both paths on the same
    # effective base_url.
    # ------------------------------------------------------------------
    effective_extra_params: Dict[str, Any] = (
        dict(extra_params) if extra_params else {}
    )

    connection = ConnectionContext(
        connection_id=connection_id,
        provider_id=provider_id,
        base_url=base_url,
        api_key=api_key,
        timeout=timeout_seconds,
        extra_params=effective_extra_params,
    )

    adapter = None
    try:
        adapter = provider_factory.create(provider_id, connection)

        # --------------------------------------------------------------
        # 2. Build the routing request — a SHORT, non-streaming call
        #    with both tools offered and tool_choice="required".
        #
        # ``tool_choice="required"`` guarantees the LLM calls a tool
        # rather than answering in prose. This is critical: without it,
        # the model may say "I will search for..." as plain text and
        # never actually invoke the tool.
        # --------------------------------------------------------------
        routing_messages = [
            {"role": "system", "content": _ROUTING_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]

        routing_request = LLMRequest(
            provider_id=provider_id,
            model_id=model_name,
            connection_id=connection_id,
            messages=routing_messages,
            system_prompt=None,
            tools=[_WEB_SEARCH_SCHEMA, _IMAGE_SEARCH_SCHEMA],
            tool_choice=ToolChoiceSpec(mode="required"),
            generation=GenerationConfig(
                temperature=0.0,
                max_output_tokens=150,
            ),
            response_format=ResponseFormat(kind="text"),
            connection=connection,
        )

        logger.info(
            "[SEARCH-EXEC] Asking LLM to route search request "
            "(provider=%r model=%r base_url=%r extra_params_keys=%r "
            "job=%s prompt=%r).",
            provider_id,
            model_name,
            base_url,
            list(effective_extra_params.keys()),
            job_id,
            prompt[:80],
        )

        routing_response = await adapter.generate(routing_request)

        # ------------------------------------------------------------------
        # Extract the LLM's decision.
        #
        # Preferred path: the provider populated ``tool_calls`` (native
        # function-calling). This is the shape returned by every
        # cloud-grade model (GPT-4o, Claude, Gemini, Qwen 2.5-72B,
        # Llama 3.3-70B, DeepSeek-V3, ...).
        #
        # Fallback path: the model wrote a JSON object into
        # ``response.content`` instead of using the native interface.
        # This is the shape returned by most small/local models
        # (Nemotron-3-nano, Qwen 2.5-7B, Llama 3.2-3B, DeepSeek-Lite)
        # and by many LM Studio / Ollama backends. ``tool_choice=
        # 'required'`` does not force them to use the native channel;
        # they obey the intent but not the transport. The fallback
        # parser recovers the decision without re-introducing any
        # intent-detection heuristics — the LLM still made the choice.
        # ------------------------------------------------------------------
        tool_calls = getattr(routing_response, "tool_calls", None) or []

        tool_name: Optional[str] = None
        parsed_args: Dict[str, Any] = {}

        if tool_calls:
            chosen_call = tool_calls[0]
            tool_name = getattr(chosen_call, "name", None)
            raw_args = getattr(chosen_call, "arguments", None)

            # Arguments may arrive as a JSON string or as a dict,
            # depending on the adapter. Normalize both shapes.
            if isinstance(raw_args, str):
                try:
                    parsed_args = json.loads(raw_args) if raw_args else {}
                except json.JSONDecodeError as parse_err:
                    logger.warning(
                        "[SEARCH-EXEC] Failed to parse tool arguments "
                        "%r for %r (job=%s): %s",
                        raw_args,
                        tool_name,
                        job_id,
                        parse_err,
                    )
                    return (None, None)
            elif isinstance(raw_args, dict):
                parsed_args = raw_args
            else:
                parsed_args = {}
        else:
            # Native tool_calls is empty. Try the content-JSON fallback.
            _content = getattr(routing_response, "content", "") or ""
            _extracted = _extract_tool_call_from_content(_content)
            if _extracted is None:
                logger.warning(
                    "[SEARCH-EXEC] LLM did not emit a tool call via "
                    "tool_calls OR parseable JSON in content "
                    "(job=%s, response_content=%r). Falling back to "
                    "no search.",
                    job_id,
                    _content[:200],
                )
                return (None, None)

            tool_name, _extracted_query, parsed_args = _extracted
            # The fallback extractor already normalized args; make
            # sure ``query`` is present in parsed_args so the shared
            # extraction code below behaves identically.
            parsed_args.setdefault("query", _extracted_query)

            logger.info(
                "[SEARCH-EXEC] Recovered tool call from content JSON "
                "(native tool_calls empty) — tool=%r query=%r "
                "(job=%s).",
                tool_name,
                parsed_args.get("query"),
                job_id,
            )

        search_query = str(parsed_args.get("query") or prompt).strip()

        logger.info(
            "[SEARCH-EXEC] LLM chose tool=%r query=%r (job=%s).",
            tool_name,
            search_query,
            job_id,
        )

        # --------------------------------------------------------------
        # 3. Execute the chosen tool.
        #
        # Only the two tools offered in the routing call are handled.
        # Any other tool name is rejected to prevent the LLM from
        # accidentally invoking a tool it was not offered (defense
        # in depth against misbehaving providers).
        # --------------------------------------------------------------
        if tool_name == "image_search":
            image_tool = ImageSearchTool(
                workspace_root=str(workspace_dir),
            )
            result = await image_tool.aexecute(query=search_query)
        elif tool_name == "web_search":
            web_tool = WebSearchTool(
                workspace_root=str(workspace_dir),
                run_id=run_id,
                job_id=job_id,
                session_id=chat_id,
                chat_id=chat_id,
                project_id=project_id,
            )
            result = await web_tool.aexecute(query=search_query)
        else:
            logger.warning(
                "[SEARCH-EXEC] LLM chose an unexpected tool %r "
                "(job=%s). Only web_search and image_search are "
                "offered. Returning no result.",
                tool_name,
                job_id,
            )
            return (None, None)

        return (result, tool_name)

    except Exception as exc:
        logger.warning(
            "[SEARCH-EXEC] Search routing/execution failed (job=%s): %s",
            job_id,
            exc,
            exc_info=True,
        )
        return (None, None)
    finally:
        if adapter is not None:
            try:
                await adapter.close()
            except Exception as close_err:
                logger.debug(
                    "[SEARCH-EXEC] adapter.close() raised (job=%s): %s",
                    job_id,
                    close_err,
                )


__all__ = ["execute_search_via_llm_choice"]

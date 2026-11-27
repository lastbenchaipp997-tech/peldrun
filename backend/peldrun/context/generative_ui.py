"""Peldrun rendering directive builder.

Builds a compact system directive describing which output formats the model
is allowed to use. The directive covers Markdown, Mermaid, LaTeX, and a
bounded JSON chart format. It intentionally does not describe any UI component
system; the frontend renders everything through a single Markdown pipeline.

The module exposes the same public surface as the previous OpenUI builder so
that `peldrun.context.builder` and both the chat and agent subsystems can call
it without modification.

Design goals:
    * Compact output (~250-350 tokens) suitable for small context windows.
    * Feature-gated: each format is only described when enabled.
    * Idempotent: re-running on the same settings yields the same string.
    * Forward-compatible: unknown keys in the settings dict are ignored.

Template note:
    `string.Template` is used instead of `str.format` for sections that
    contain literal `{` and `}` characters (JSON examples in the chart
    rules). Using `str.format` would raise a KeyError on those braces.
"""
# backend\peldrun\context\generative_ui.py


from __future__ import annotations

import logging
import re
from string import Template
from typing import Any, Dict, List, Optional

logger = logging.getLogger("peldrun.context.generative_ui")

# ---------------------------------------------------------------------------
# Limits and defaults
# ---------------------------------------------------------------------------

MIN_OUTPUT_TOKENS = 512
MAX_OUTPUT_TOKENS = 8192
DEFAULT_OUTPUT_TOKENS = 4096

MIN_RETRIES = 0
MAX_RETRIES = 5
DEFAULT_RETRIES = 1

# v3: Maximum number of image references forwarded to the model inside the
# [Image Search Results] block. Keeping this bounded protects the context
# window on small models and mirrors MAX_IMAGE_REFS in the frontend.
MAX_IMAGE_REFS = 8

# Default per-format limits. These can be overridden per-request via the
# `limits` sub-object of the settings dictionary.
DEFAULT_FEATURES: Dict[str, bool] = {
    "mermaid": True,
    "latex": True,
    "charts": True,
    "code_highlighting": True,
    # v3: UI cards block. Disabled by default; the model must not emit
    # ```ui blocks unless the user explicitly enables the feature.
    "cards": False,
    # v3: Allow the model to request images via image.query. Requires
    # `cards` to be on; spends the configured image-search provider quota.
    "cards_auto_images": False,
}

DEFAULT_LIMITS: Dict[str, int] = {
    "max_mermaid_nodes": 40,
    "max_chart_points": 30,
    "max_table_rows": 50,
    # v3: Upper bound on cards inside a single ```ui block.
    "max_cards": 6,
    # DEPRECATED: this field is retained only for on-disk compatibility with
    # previously saved settings. It is NOT consumed by any code path — the
    # effective `max_tokens` is resolved per-model by
    # `omweb.agent_bridge_parts.dispatcher._resolve_model_max_output_tokens`
    # from `active_llm` and `storage/models_budget.json`. Do not introduce
    # new usages of this field.
    "max_output_tokens": DEFAULT_OUTPUT_TOKENS,
}

# Feature key aliases. Accept both snake_case and camelCase from callers.
FEATURE_ALIASES: Dict[str, str] = {
    "mermaid": "mermaid",
    "diagrams": "mermaid",
    "latex": "latex",
    "math": "latex",
    "charts": "charts",
    "chart": "charts",
    "code": "code_highlighting",
    "code_highlighting": "code_highlighting",
    # v3: UI cards. "ui" is accepted as a short alias so older payloads
    # (which used the fenced `ui` tag) continue to map to the same feature.
    "cards": "cards",
    "ui": "cards",
    "cards_auto_images": "cards_auto_images",
}

LIMIT_ALIASES: Dict[str, str] = {
    "max_mermaid_nodes": "max_mermaid_nodes",
    "maxMermaidNodes": "max_mermaid_nodes",
    "max_chart_points": "max_chart_points",
    "maxChartPoints": "max_chart_points",
    "max_table_rows": "max_table_rows",
    "maxTableRows": "max_table_rows",
    "max_output_tokens": "max_output_tokens",
    "maxOutputTokens": "max_output_tokens",
    # v3: Card count cap.
    "max_cards": "max_cards",
    "maxCards": "max_cards",
}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _clamp_integer(
    value: Any,
    *,
    minimum: int,
    maximum: int,
    default: int,
) -> int:
    """Convert a value to an int and clamp it to [minimum, maximum]."""
    if isinstance(value, bool):
        parsed = default
    else:
        try:
            parsed = int(value)
        except (TypeError, ValueError, OverflowError):
            parsed = default
    return max(minimum, min(maximum, parsed))


def _clamp_max_tokens(value: Any) -> int:
    """Return a safe output-token budget for the model call layer."""
    return _clamp_integer(
        value,
        minimum=MIN_OUTPUT_TOKENS,
        maximum=MAX_OUTPUT_TOKENS,
        default=DEFAULT_OUTPUT_TOKENS,
    )


def _is_enabled(settings: Optional[Dict[str, Any]]) -> bool:
    """Return True only when the feature flag is explicitly enabled."""
    if not isinstance(settings, dict):
        return False
    return bool(settings.get("enabled"))


def _normalize_features(settings: Dict[str, Any]) -> Dict[str, bool]:
    """Resolve the effective feature flags, applying aliases and defaults."""
    raw = settings.get("features")
    if not isinstance(raw, dict):
        raw = {}

    resolved: Dict[str, bool] = dict(DEFAULT_FEATURES)
    for key, value in raw.items():
        canonical = FEATURE_ALIASES.get(key)
        if canonical is None:
            continue
        resolved[canonical] = bool(value)
    return resolved


def _normalize_limits(settings: Dict[str, Any]) -> Dict[str, int]:
    """Resolve the effective per-format limits, applying aliases and defaults."""
    raw = settings.get("limits")
    if not isinstance(raw, dict):
        raw = {}

    resolved: Dict[str, int] = dict(DEFAULT_LIMITS)
    for key, value in raw.items():
        canonical = LIMIT_ALIASES.get(key)
        if canonical is None:
            continue
        if canonical == "max_output_tokens":
            resolved[canonical] = _clamp_max_tokens(value)
        else:
            resolved[canonical] = _clamp_integer(
                value,
                minimum=1,
                maximum=500,
                default=DEFAULT_LIMITS[canonical],
            )

    # Top-level max_output_tokens overrides the nested value for backward
    # compatibility with the previous settings shape.
    if "max_output_tokens" in settings:
        resolved["max_output_tokens"] = _clamp_max_tokens(
            settings["max_output_tokens"]
        )

    return resolved


def _has_any_feature(features: Dict[str, bool]) -> bool:
    """True when at least one non-default rendering feature is active."""
    return any(
        features.get(key, False)
        for key in ("mermaid", "latex", "charts", "cards")
    )


# ---------------------------------------------------------------------------
# Directive sections
# ---------------------------------------------------------------------------

_BASE_RULES = (
    "[RENDERING POLICY]\n"
    "Respond in Markdown. Use the additional formats described below only "
    "when they materially improve the answer.\n"
    "\n"
    "General rules:\n"
    "- Never emit raw HTML tags such as <div>, <span>, <style>, <table>, "
    "or <svg>.\n"
    "- Do not use placeholder text or references such as \"see the table "
    "above\".\n"
    "- Never fabricate data to fill a visual. Use only values supplied by "
    "the user or available in tool results.\n"
    "- Keep headings, lists, and tables within Markdown conventions."
)

# Uses $max_nodes as a Template placeholder.
# Do not use {max_nodes}; braces are reserved for literal text.
_MERMAID_RULES = (
    "[MERMAID DIAGRAMS]\n"
    "- Emit diagrams inside fenced code blocks with the `mermaid` language "
    "tag.\n"
    "- Prefer the modern `flowchart LR` or `flowchart TD` directive.\n"
    "- Avoid the legacy `graph` directive, `classDef`, `class`, and "
    "`linkStyle`.\n"
    "- Node identifiers must be plain ASCII (letters, digits, underscore).\n"
    "- Do not embed HTML, JavaScript, or external URLs in node labels.\n"
    "- Supported diagram types: flowchart, sequenceDiagram, gantt, "
    "stateDiagram, classDiagram, erDiagram, journey, timeline, pie, mindmap.\n"
    "- Limit total nodes to at most $max_nodes."
)

_LATEX_RULES = (
    "[LATEX MATH]\n"
    "- Inline math: wrap expressions in single dollar signs, e.g. $E = mc^2$.\n"
    "- Display math: wrap expressions in double dollar signs on their own "
    "lines.\n"
    "- Never use \\[...\\] or \\(...\\) delimiters; they are not supported.\n"
    "- Avoid custom macros and \\newcommand definitions.\n"
    "- Prefer plain LaTeX primitives (\\frac, \\sum, \\int, \\left, \\right)."
)

# Uses $max_points as a Template placeholder.
# The JSON examples below contain literal { and } characters; they are NOT
# placeholders and must survive templating unchanged.
_CHART_RULES = (
    "[CHARTS]\n"
    "Two options are available. Choose the simpler one when possible.\n"
    "\n"
    "Option 1 - Mermaid xychart (recommended for simple line and bar data):\n"
    "```mermaid\n"
    "xychart-beta\n"
    "    title \"Monthly Revenue\"\n"
    "    x-axis [Jan, Feb, Mar, Apr]\n"
    "    y-axis \"USD (millions)\" 0 --> 100\n"
    "    bar [42, 55, 61, 74]\n"
    "```\n"
    "\n"
    "Option 2 - JSON chart (for multi-series, area, pie, or donut):\n"
    "```chart\n"
    "{\n"
    "  \"type\": \"line\",\n"
    "  \"title\": \"Revenue vs Cost\",\n"
    "  \"unit\": \"USD (millions)\",\n"
    "  \"data\": [\n"
    "    {\"label\": \"Q1\", \"revenue\": 42, \"cost\": 30},\n"
    "    {\"label\": \"Q2\", \"revenue\": 55, \"cost\": 35}\n"
    "  ],\n"
    "  \"xAxisKey\": \"label\",\n"
    "  \"seriesKeys\": [\"revenue\", \"cost\"]\n"
    "}\n"
    "```\n"
    "\n"
    "JSON chart constraints:\n"
    "- `type` must be one of: bar, line, area, donut, pie.\n"
    "- `data` must be a non-empty array of objects.\n"
    "- Limit total data points to at most $max_points."
)

_CODE_RULES = (
    "[CODE BLOCKS]\n"
    "- Always include a language tag on fenced code blocks.\n"
    "- For plain text content that must preserve whitespace (for example a "
    "cover page layout), use the `text` language tag or no tag at all.\n"
    "- Do not wrap ordinary prose in a code block."
)

# Uses $max_rows as a Template placeholder.
# Tables are Markdown-native, so they don't require a dedicated feature
# toggle — they are gated by the same directive-emission rule as
# `_CODE_RULES`. The row cap is a hard advisory to the model; the renderer
# itself does not truncate (a truncated table would silently lose data).
_TABLE_RULES = (
    "[TABLES]\n"
    "- Use Markdown pipe tables for structured tabular data.\n"
    "- Never emit HTML tables; the renderer understands Markdown pipes only.\n"
    "- Every table must have a header row followed by a separator row "
    "(`|---|---|`).\n"
    "- Keep each table at most $max_rows rows; split larger datasets into "
    "multiple tables with a heading above each."
)

# v3: UI cards directive. Uses $image_rule and $max_cards as Template
# placeholders. All other braces are literal JSON examples and must
# survive templating unchanged (hence Template, not str.format).
_CARD_RULES = (
    "[UI CARDS]\n"
    "- For results that are better scanned than read (places, options, products, "
    "categories, summaries), emit ONE fenced block tagged `ui` containing one JSON "
    "object, preceded by a single prose sentence.\n"
    "- Single card: {\"type\":\"card\",\"layout\":\"media-start\",\"title\":\"...\","
    "\"subtitle\":\"...\",\"icon\":\"map\",\"accent\":\"blue\",\"style\":\"tinted\","
    "\"image\":{\"ref\":\"img_1\",\"alt\":\"...\"},"
    "\"tags\":[\"A\",{\"label\":\"B\",\"accent\":\"green\"}],"
    "\"stats\":[{\"label\":\"...\",\"value\":\"...\"}],"
    "\"actions\":[{\"label\":\"...\",\"prompt\":\"...\"}]}\n"
    "- Several cards: {\"type\":\"grid\",\"columns\":2,\"items\":[<card>,<card>]}\n"
    "- Sequential explanation / layered map: "
    "{\"type\":\"flow\",\"direction\":\"vertical\",\"title\":\"...\","
    "\"items\":[{\"title\":\"...\",\"subtitle\":\"...\",\"icon\":\"map\","
    "\"accent\":\"blue\",\"style\":\"tinted\"},...]}. Use for step-by-step "
    "processes, layered architectures, or concept maps with 3+ stages. Each "
    "item renders as its own card with an arrow to the next. direction is "
    "`vertical` (default) or `horizontal`; prefer horizontal for short 2-4 "
    "stage flows and vertical for deeper processes. Items accept the same "
    "optional fields as a single card; `stats` and `actions` are ignored "
    "inside a flow.\n"
    "- Interactive form: {\"type\":\"form\",\"title\":\"...\","
    "\"description\":\"...\",\"accent\":\"blue\",\"style\":\"tinted\","
    "\"questions\":[{\"id\":\"q1\",\"label\":\"...\",\"type\":\"single\"|\"multi\","
    "\"required\":true,\"options\":[{\"id\":\"a\",\"label\":\"...\"},...]}],"
    "\"submitLabel\":\"...\","
    "\"submitPrompt\":\"Answers: {{q1}} / {{q2}}. Suggest a plan.\"}. Use a form "
    "when the user's request genuinely needs clarifying answers before you can "
    "proceed (budget, preferences, scope, constraints). Each question is either "
    "`single` (radio buttons) or `multi` (checkboxes). At submit time, "
    "`{{qid}}` placeholders are replaced with the comma-joined labels the user "
    "selected, and the resulting string is sent as the user's next message. If "
    "`submitPrompt` is omitted, a plain list of answers is sent instead. Max 6 "
    "questions, 8 options each; use `required: true` only for questions the "
    "answer genuinely cannot proceed without.\n"
    "- layout is one of: vertical, media-start, media-end, overlay, tile, compact. "
    "Use tile for category overviews (icon + title + tags), media-start for lists "
    "with pictures, overlay for a hero item.\n"
    "- icon is one of: map, route, pin, chart-line, chart-bar, chart-pie, flow, grid, "
    "table, calendar, activity, document, info, star, users, clock, globe, package, idea.\n"
    "- accent is optional. One of: blue, sky, cyan, teal, emerald, green, lime, amber, "
    "yellow, orange, red, rose, pink, fuchsia, purple, violet, indigo, slate. "
    "Renders as a soft pastel background. Use it to group related cards, "
    "emphasize a hero item, or color-code layers of a flow.\n"
    "- style is optional and one of: tinted (default; soft gradient), outlined "
    "(2px border, transparent fill), minimal (very light tint, thin border). "
    "Choose a style per card to express hierarchy: tinted for primary items, "
    "outlined for secondary options, minimal for dense category grids.\n"
    "- tags: each entry is either a plain string (inherits the card's accent, "
    "or falls back to muted gray when the card has no accent) or "
    "{\"label\":\"...\",\"accent\":\"...\"} for a per-tag color. Use tag colors "
    "for status (green = ok, red = problem, amber = caution) or group "
    "membership.\n"
    "- Write every visible string in the user's language. Keys and enum values stay English.\n"
    "$image_rule\n"
    "- Plain text only inside strings: no Markdown, no HTML. Title <= 60 chars.\n"
    "- At most $max_cards cards per block."
)

# v3: Image rule when auto-image is OFF. The model may only reference image
# ids already listed under [Image Search Results] in the user message.
_IMAGE_RULE_REF_ONLY = (
    "- image.ref must be an id (img_1, img_2, ...) listed under [Image Search Results] "
    "in the user message. Never write image URLs. If no ids are listed, omit image."
)

# v3: Image rule when auto-image is ON. The model may reference an existing
# id, or supply a short search query that is resolved server-side after the
# response completes.
_IMAGE_RULE_WITH_QUERY = (
    "- image: if ids (img_1, ...) are listed under [Image Search Results], use image.ref. "
    "Otherwise, for a card about a specific well-known place, landmark, product, animal "
    "or artwork where a photo clearly helps, set image.query to a short search phrase "
    "(2-6 words, usually the English name). At most 6 cards per block get image.query. "
    "Omit image for people, abstract topics, or when unsure. Never write image URLs."
)


def _build_sections(
    features: Dict[str, bool],
    limits: Dict[str, int],
) -> List[str]:
    """Assemble the directive sections based on the active features.

    Uses `string.Template` instead of `str.format` because the chart rules
    contain literal `{` and `}` characters (JSON examples) that would be
    interpreted as format placeholders by `str.format` and raise a
    KeyError at runtime.
    """
    sections: List[str] = [_BASE_RULES]

    # Table constraints are emitted whenever any directive section is
    # produced (i.e., at least one of mermaid / latex / charts is active).
    # They are intentionally placed right after the base rules because the
    # row cap applies regardless of which visual format the model chooses.
    table_template = Template(_TABLE_RULES)
    sections.append(
        table_template.safe_substitute(
            max_rows=limits["max_table_rows"],
        )
    )

    if features.get("mermaid"):
        template = Template(_MERMAID_RULES)
        sections.append(
            template.safe_substitute(
                max_nodes=limits["max_mermaid_nodes"],
            )
        )

    if features.get("latex"):
        sections.append(_LATEX_RULES)

    if features.get("charts"):
        template = Template(_CHART_RULES)
        sections.append(
            template.safe_substitute(
                max_points=limits["max_chart_points"],
            )
        )

    if features.get("code_highlighting"):
        sections.append(_CODE_RULES)

    # v3: UI cards section. The image rule depends on whether the user has
    # opted into auto-image search: default is ref-only (safe), opt-in also
    # allows image.query (spends the search provider quota server-side).
    if features.get("cards"):
        image_rule = (
            _IMAGE_RULE_WITH_QUERY
            if features.get("cards_auto_images")
            else _IMAGE_RULE_REF_ONLY
        )
        card_template = Template(_CARD_RULES)
        sections.append(
            card_template.safe_substitute(
                max_cards=limits["max_cards"],
                image_rule=image_rule,
            )
        )

    return sections


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_max_output_tokens(settings: Optional[Dict[str, Any]]) -> int:
    """Return the effective output-token budget for the current request."""
    if not _is_enabled(settings):
        return DEFAULT_OUTPUT_TOKENS
    assert isinstance(settings, dict)
    limits = _normalize_limits(settings)
    return limits["max_output_tokens"]


def get_max_retries(settings: Optional[Dict[str, Any]]) -> int:
    """Return the bounded retry count for the caller's parse policy."""
    if not _is_enabled(settings):
        return 0
    assert isinstance(settings, dict)
    return _clamp_integer(
        settings.get("max_retries"),
        minimum=MIN_RETRIES,
        maximum=MAX_RETRIES,
        default=DEFAULT_RETRIES,
    )


def build_generative_ui_prompt(settings: Optional[Dict[str, Any]]) -> str:
    """Build the rendering directive for the active configuration.

    Returns an empty string when the feature is disabled or when no
    rendering feature is enabled. The output is intentionally compact so it
    can be prepended to the system message without crowding the context
    window on small models.

    The function is safe to call from both the chat subsystem and the agent
    subsystem; it has no side effects and does not depend on request state
    beyond the settings dictionary.
    """
    if not _is_enabled(settings):
        return ""

    assert isinstance(settings, dict)
    features = _normalize_features(settings)
    limits = _normalize_limits(settings)

    if not _has_any_feature(features):
        # Feature toggle is on but every rendering feature is off; emit
        # nothing so the model defaults to plain Markdown.
        logger.debug("Rendering directive requested but no feature is active")
        return ""

    sections = _build_sections(features, limits)
    return "\n\n".join(sections)


# ---------------------------------------------------------------------------
# Public helpers for UI cards (v3)
# ---------------------------------------------------------------------------


def _one_line(value: Any, limit: int) -> str:
    """Collapse untrusted text to a single-line, brace-free string.

    Card and image titles may come from arbitrary web pages. The result is
    embedded inside a JSON payload, so we strip characters that could break
    the surrounding fences (backticks) or the JSON parser (braces), and cap
    the length to avoid pathological payload sizes.
    """
    return re.sub(r"[\s{}<>`]+", " ", str(value or "")).strip()[:limit]


def cards_enabled(settings: Optional[Dict[str, Any]]) -> bool:
    """True when the global feature is on AND the `cards` sub-feature is on."""
    if not _is_enabled(settings):
        return False
    assert isinstance(settings, dict)
    return bool(_normalize_features(settings).get("cards"))


def cards_auto_images_enabled(settings: Optional[Dict[str, Any]]) -> bool:
    """True when cards are on AND the user opted into automatic image search."""
    if not cards_enabled(settings):
        return False
    assert isinstance(settings, dict)
    return bool(_normalize_features(settings).get("cards_auto_images"))


def format_image_refs(images: Any, limit: int = MAX_IMAGE_REFS) -> str:
    """Render the [Image Search Results] block for the model.

    Each line has the form:
        img_<n>: <title> (<host>, <WxH>)

    The 1-based index maps directly to the gallery index built by the
    frontend, so `image.ref = "img_1"` resolves to the first image in the
    gallery without an extra lookup table.
    """
    if not isinstance(images, list):
        return ""
    lines: List[str] = []
    for idx, img in enumerate(images[:limit], start=1):
        if not isinstance(img, dict):
            continue
        title = _one_line(img.get("title"), 70) or "image"
        host = _one_line(img.get("source"), 40)
        w, h = img.get("width"), img.get("height")
        dims = f"{w}x{h}" if isinstance(w, int) and isinstance(h, int) else ""
        meta = ", ".join(x for x in (host, dims) if x)
        lines.append(f"img_{idx}: {title}" + (f" ({meta})" if meta else ""))
    return "\n".join(lines)


__all__ = [
    "DEFAULT_FEATURES",
    "DEFAULT_LIMITS",
    "MAX_IMAGE_REFS",
    "MAX_OUTPUT_TOKENS",
    "MIN_OUTPUT_TOKENS",
    "build_generative_ui_prompt",
    "cards_auto_images_enabled",
    "cards_enabled",
    "format_image_refs",
    "get_max_output_tokens",
    "get_max_retries",
]

# backend/omweb/agent_bridge_parts/card_images.py
"""
Card image resolution for the v3 UI card feature.

When ``cards_auto_images`` is enabled, the model may supply ``image.query``
instead of ``image.ref`` inside a ```ui card block. This module walks those
blocks, searches for the requested topics through the configured image
search provider, and appends the resulting images to the message gallery.

Design constraints
------------------
* ``ImageSearchTool`` MUST be created with ``workspace_root=None`` so the
  resolver can never download image bytes into a workspace as a side
  effect of rendering a card. "Auto image search" is permission to LOOK
  UP images, not to persist them.
* Total time is bounded at ``TOTAL_TIMEOUT_SECONDS`` and per-query at
  ``QUERY_TIMEOUT_SECONDS``; concurrency is capped at
  ``MAX_CONCURRENT_SEARCHES``. This bounds both the latency added before
  the ``final`` SSE event and the provider quota spent by one message
  (see ``MAX_TOTAL_QUERIES``).
* A search that fails, times out, or returns no usable image is silently
  skipped. The card renders without an image and the gallery keeps
  whatever the manual search (if any) produced.

Public API
----------
    extract_card_image_queries(text) -> List[str]
    uses_card_refs(text) -> bool
    resolve_card_images(text, gallery, *, run_id, job_id, chat_id, project_id)
        -> (new_gallery, query_map, used_in_cards)
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)


# Match ```ui ... ``` fenced blocks. The optional `\s*` after `ui`
# tolerates "```ui\r\n", "```ui\n", and "```ui\n  " (leading spaces).
UI_BLOCK_RE = re.compile(r"```ui\s*\n?(.*?)```", re.DOTALL)

# Trailing commas before a closing brace/bracket are common in model
# output and invalid JSON. Stripped only on the second parse attempt,
# so valid JSON is never mutated.
_TRAILING_COMMA_RE = re.compile(r",(\s*[}\]])")

# Hard limits. MAX_TOTAL_QUERIES matches the prompt rule
# "At most 6 cards per block get image.query", so a model that ignores
# the rule cannot spend unbounded provider quota in one message.
MAX_TOTAL_QUERIES = 6
QUERY_TIMEOUT_SECONDS = 8.0
TOTAL_TIMEOUT_SECONDS = 10.0
MAX_CONCURRENT_SEARCHES = 3
MAX_QUERY_LENGTH = 200


def normalize_query_key(query: str) -> str:
    """Lowercase + collapse whitespace. Must mirror the frontend helper."""
    if not isinstance(query, str):
        return ""
    return re.sub(r"\s+", " ", query.strip()).lower()


def _is_url(value: str) -> bool:
    """True for strings that look like an http(s) URL or a bare www host."""
    low = value.lower()
    return low.startswith(("http://", "https://", "www."))


def _parse_ui_blocks(text: str) -> Iterable[Any]:
    """Yield the parsed JSON object of every ```ui block in ``text``.

    A block that fails to parse (both on the first attempt and after
    stripping trailing commas) is silently skipped: one bad block must
    not prevent the other blocks from being scanned.
    """
    if not text or not isinstance(text, str):
        return
    for match in UI_BLOCK_RE.finditer(text):
        raw = match.group(1).strip()
        if not raw:
            continue
        try:
            yield json.loads(raw)
            continue
        except json.JSONDecodeError:
            pass
        try:
            yield json.loads(_TRAILING_COMMA_RE.sub(r"\1", raw))
        except json.JSONDecodeError as exc:
            logger.debug("[CARD-IMAGES] Could not parse ui block: %s", exc)


def _iter_image_dicts(node: Any) -> Iterable[Dict[str, Any]]:
    """Yield every ``image`` dict found anywhere in the JSON tree."""
    if isinstance(node, dict):
        image = node.get("image")
        if isinstance(image, dict):
            yield image
        for value in node.values():
            yield from _iter_image_dicts(value)
    elif isinstance(node, list):
        for item in node:
            yield from _iter_image_dicts(item)


def extract_card_image_queries(text: str) -> List[str]:
    """Return the unique, non-URL ``image.query`` strings in ``text``.

    Order is first-occurrence. Deduplication is case-insensitive
    (normalized via ``normalize_query_key``). URLs are rejected so a
    model that ignores the "never write URLs" rule cannot smuggle one
    into the search provider. Capped at ``MAX_TOTAL_QUERIES``.
    """
    seen: set = set()
    result: List[str] = []
    for parsed in _parse_ui_blocks(text):
        for image in _iter_image_dicts(parsed):
            raw = image.get("query")
            if not isinstance(raw, str):
                continue
            cleaned = re.sub(r"\s+", " ", raw).strip()
            if not cleaned or len(cleaned) > MAX_QUERY_LENGTH:
                continue
            if _is_url(cleaned):
                continue
            key = cleaned.lower()
            if key in seen:
                continue
            seen.add(key)
            result.append(cleaned)
            if len(result) >= MAX_TOTAL_QUERIES:
                return result
    return result


def uses_card_refs(text: str) -> bool:
    """True when any ```ui block sets a non-empty ``image.ref``."""
    for parsed in _parse_ui_blocks(text):
        for image in _iter_image_dicts(parsed):
            ref = image.get("ref")
            if isinstance(ref, str) and ref.strip():
                return True
    return False


async def _search_one_query(query: str) -> Optional[Dict[str, Any]]:
    """Search for one query and return the first valid image dict.

    The tool is created per query with ``workspace_root=None`` so
    downloads are impossible. Returns None on any failure (import
    error, constructor error, timeout, provider error, empty result).
    """
    try:
        from peldrun.tools.builtins.image_search import ImageSearchTool
    except Exception as exc:
        logger.debug(
            "[CARD-IMAGES] Could not import ImageSearchTool: %s", exc,
        )
        return None

    try:
        tool = ImageSearchTool(workspace_root=None)
    except Exception as exc:
        logger.debug(
            "[CARD-IMAGES] Could not construct ImageSearchTool: %s", exc,
        )
        return None

    try:
        result = await asyncio.wait_for(
            tool.aexecute(query=query),
            timeout=QUERY_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.debug(
            "[CARD-IMAGES] Search %r timed out after %.1fs",
            query, QUERY_TIMEOUT_SECONDS,
        )
        return None
    except Exception as exc:
        logger.debug("[CARD-IMAGES] Search %r raised: %s", query, exc)
        return None

    if result is None or getattr(result, "is_error", False):
        return None

    meta = getattr(result, "metadata", None)
    if not isinstance(meta, dict):
        return None
    images = meta.get("images")
    if not isinstance(images, list):
        return None

    for image in images:
        if not isinstance(image, dict):
            continue
        if not str(image.get("image_url") or "").strip():
            continue
        return image
    return None


def _to_proxied(image: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Convert a raw image dict into the gallery's proxied shape.

    Returns None if the raw image has no usable ``image_url`` or if the
    proxy builder raises (e.g. SSRF rejection for a private host).
    """
    raw_url = str(image.get("image_url") or "").strip()
    if not raw_url:
        return None
    try:
        from omweb.routers.image_proxy_rtr import build_proxy_url as _build_proxy_url

        src_host = str(image.get("source") or "").strip()
        raw_thumb = str(image.get("thumbnail_url") or "").strip()
        return {
            "title": str(image.get("title") or "Untitled Image"),
            "image_url": _build_proxy_url(raw_url, src_host),
            "thumbnail_url": (
                _build_proxy_url(raw_thumb, src_host) if raw_thumb else None
            ),
            "source_url": str(image.get("source_url") or "").strip() or None,
            "width": image.get("width"),
            "height": image.get("height"),
            "source": src_host or None,
        }
    except Exception as exc:
        logger.debug(
            "[CARD-IMAGES] Proxy build failed for %r: %s", raw_url, exc,
        )
        return None


async def _resolve_single(
    query: str,
    semaphore: asyncio.Semaphore,
) -> Tuple[str, Optional[Dict[str, Any]]]:
    """Acquire the semaphore, run one search, return (query, image_or_none)."""
    async with semaphore:
        image = await _search_one_query(query)
        return query, image


async def resolve_card_images(
    result_text: str,
    gallery_images: List[Dict[str, Any]],
    *,
    run_id: str,
    job_id: str,
    chat_id: str,
    project_id: str,
) -> Tuple[List[Dict[str, Any]], Dict[str, int], bool]:
    """Resolve ``image.query`` strings into gallery entries.

    Parameters
    ----------
    result_text : the assistant's final text (already containing any
        ```ui blocks the model emitted).
    gallery_images : the current gallery, in the proxied format used by
        ``append_image_gallery_block``. It may be empty (no manual search)
        or carry the user's manual-search results.
    run_id / job_id / chat_id / project_id : forwarded for telemetry.
        ``run_id`` and ``job_id`` are the same value.

    Returns
    -------
    (new_gallery, query_map, used_in_cards)

    new_gallery    : a NEW list (the input is never mutated) containing
                     the original entries plus one proxied image per
                     resolved query.
    query_map      : ``normalized_query -> 1-based gallery index`` in the
                     returned ``new_gallery``.
    used_in_cards  : True when the model used ``image.ref`` OR when at
                     least one ``image.query`` was resolved. When False,
                     the dispatcher keeps the gallery visible so the
                     user sees whatever the manual search produced.
    """
    base_gallery: List[Dict[str, Any]] = (
        list(gallery_images) if isinstance(gallery_images, list) else []
    )

    used_refs = uses_card_refs(result_text)
    queries = extract_card_image_queries(result_text)

    if not queries:
        return base_gallery, {}, used_refs

    logger.info(
        "[CARD-IMAGES] Resolving %d unique image.query string(s) "
        "for job %s (run_id=%s chat=%s project=%s)",
        len(queries), job_id, run_id, chat_id, project_id,
    )

    semaphore = asyncio.Semaphore(MAX_CONCURRENT_SEARCHES)
    tasks = [
        asyncio.create_task(_resolve_single(q, semaphore))
        for q in queries
    ]

    try:
        done, pending = await asyncio.wait(
            tasks, timeout=TOTAL_TIMEOUT_SECONDS,
        )
    except asyncio.CancelledError:
        # Preserve cancellation semantics: clean up children and re-raise
        # so the outer job task's CancelledError handler runs.
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
    except Exception as exc:
        logger.debug(
            "[CARD-IMAGES] asyncio.wait failed for job %s: %s",
            job_id, exc,
        )
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        return base_gallery, {}, used_refs

    # Cancel anything still running and wait for it to actually stop so
    # we do not leak tasks.
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)

    resolved: Dict[str, Optional[Dict[str, Any]]] = {}
    for task in done:
        try:
            q, image = task.result()
            resolved[q] = image
        except asyncio.CancelledError:
            continue
        except Exception as exc:
            logger.debug("[CARD-IMAGES] Per-query task raised: %s", exc)

    new_gallery = list(base_gallery)
    query_map: Dict[str, int] = {}
    any_query_resolved = False

    # Preserve query order in the appended entries so the gallery's
    # display order matches the model's reading order.
    for q in queries:
        image = resolved.get(q)
        if image is None:
            continue
        proxied = _to_proxied(image)
        if proxied is None:
            continue
        new_gallery.append(proxied)
        query_map[normalize_query_key(q)] = len(new_gallery)
        any_query_resolved = True

    if not any_query_resolved:
        logger.info(
            "[CARD-IMAGES] No queries resolved for job %s "
            "(all failed or timed out)", job_id,
        )
        return base_gallery, {}, used_refs

    logger.info(
        "[CARD-IMAGES] Resolved %d/%d queries for job %s "
        "(gallery %d -> %d, used_in_cards=%s)",
        len(query_map), len(queries), job_id,
        len(base_gallery), len(new_gallery),
        used_refs or any_query_resolved,
    )

    return new_gallery, query_map, used_refs or any_query_resolved


__all__ = [
    "MAX_CONCURRENT_SEARCHES",
    "MAX_TOTAL_QUERIES",
    "QUERY_TIMEOUT_SECONDS",
    "TOTAL_TIMEOUT_SECONDS",
    "extract_card_image_queries",
    "normalize_query_key",
    "resolve_card_images",
    "uses_card_refs",
]

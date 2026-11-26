# backend/omweb/agent_bridge_parts/dispatcher/image_results.py
"""
Image-search result emission for chat mode.

Extracted from ``dispatcher.py``. Behavior preserved verbatim.

This is the SINGLE emission point for image results in direct-chat mode.
Agent mode emits the equivalent event from ``peldrun_engine.py`` after
parsing the ``image_search`` observation output.

IMPORT DISCIPLINE
-----------------
``build_proxy_url`` is imported INSIDE the function, and it is imported
BEFORE the payload check -- exactly as the original did. Both details
matter:

  * Lazy: breaks the module-load cycle
    dispatcher -> omweb.routers.__init__ -> run_routes/files
      -> omweb.agent_bridge -> agent_bridge_parts -> dispatcher
  * Order: an ImportError must surface identically to the original even
    when ``meta`` carries no images. Moving the import below the early
    return would silently change failure behavior.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from omweb.sse_events import SSEEvent, SSEEventType, dispatch_event

logger = logging.getLogger(__name__)


async def emit_image_results_event_if_present(
    job_id: str,
    step: int,
    meta: Dict[str, Any],
    query: str,
) -> Optional[List[Dict[str, Any]]]:
    """
    If `meta.images` contains image results, emit an IMAGE_RESULTS SSE
    event with fully-formed proxy URLs and return the list of proxied
    image dicts. Otherwise return None (no event emitted).

    The returned list is also used by the caller to embed an
    ``image_gallery`` markdown block into the final result text so the
    gallery survives a page refresh (the frontend cannot reconstruct
    proxy URLs on its own, and chat mode does not render the timeline).

    FAILURE SEMANTICS
    -----------------
    Emission is best-effort: if ``dispatch_event`` raises, the function
    logs at DEBUG and returns ``None``. Returning ``None`` (rather than
    the proxied list) is deliberate -- the caller then treats the turn as
    a text-only search and does not embed a gallery the user never saw.
    """
    # Lazy import to break a pre-existing module-load cycle (see module
    # docstring). Kept BEFORE the payload check to preserve the original
    # failure ordering.
    from omweb.routers.image_proxy_rtr import build_proxy_url as _build_proxy_url

    images_data = meta.get("images")
    if not isinstance(images_data, list) or not images_data:
        return None

    proxied: List[Dict[str, Any]] = []
    for img in images_data:
        if not isinstance(img, dict):
            continue
        img_url = str(img.get("image_url") or "").strip()
        if not img_url:
            continue
        thumb_url = str(img.get("thumbnail_url") or "").strip()
        src_page = str(img.get("source_url") or "").strip()
        src_host = str(img.get("source") or "").strip()
        proxied.append(
            {
                "title": str(img.get("title") or "Untitled Image"),
                "image_url": _build_proxy_url(img_url, src_host),
                "thumbnail_url": (
                    _build_proxy_url(thumb_url, src_host)
                    if thumb_url
                    else None
                ),
                "source_url": src_page or None,
                "width": img.get("width"),
                "height": img.get("height"),
                "source": src_host or None,
            }
        )

    if not proxied:
        return None

    try:
        await dispatch_event(
            job_id,
            SSEEvent(
                type=SSEEventType.IMAGE_RESULTS,
                step=step,
                data={
                    "query": query,
                    "provider": str(meta.get("provider") or "unknown"),
                    "images": proxied,
                    "count": len(proxied),
                    "latency_ms": float(meta.get("latency_ms") or 0.0),
                    "estimated_cost_usd": float(
                        meta.get("estimated_cost_usd") or 0.0
                    ),
                },
            ),
        )
        return proxied
    except Exception as exc:
        logger.debug(
            "[BRIDGE DIRECT CHAT] Failed to emit IMAGE_RESULTS for job %s: %s",
            job_id,
            exc,
        )
        return None


__all__ = ["emit_image_results_event_if_present"]

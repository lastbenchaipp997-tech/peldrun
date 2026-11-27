# backend/omweb/agent_bridge_parts/dispatcher/chat_media.py
"""
Chat-mode image handling: multimodal input injection + gallery persistence.

Two responsibilities, both extracted verbatim from ``run_direct_chat``:

  * ``inject_image_attachments``    -- attachments -> ``image_url`` parts
  * ``append_image_gallery_block``  -- search images -> persisted markdown

Neither exists in agent mode: the agent runtime handles attachments in
``peldrun.runtime.executor`` and emits its gallery from
``peldrun_engine.py``. This module is CHAT-ONLY by design.

PATH RESOLUTION ORDER (load-bearing)
------------------------------------
  1. ``<workspace>/.peldrun/user_uploads/<fileId>``   <-- FIRST
  2. ``<storage>/artifacts/temp/<fileId>``            <-- fallback

``start_run.py`` copies attachments into the workspace and then DELETES
the temp original as soon as the copy succeeds. Reading temp first would
therefore make every attachment unreadable after the very first turn.
This mirrors the ordering in ``peldrun.runtime.executor``.

SECURITY
--------
``fileId`` is rejected if it contains ``/``, ``\\`` or ``..``. This is the
only thing standing between a client-supplied id and arbitrary file reads,
because the id is joined onto a trusted directory. Do not relax it.

FAILURE SEMANTICS
-----------------
Both functions are best-effort and never raise. A missing/unreadable
image degrades to a text-only turn; a JSON serialization failure degrades
to a result without the gallery block.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Extension -> MIME map for data URLs. Unknown extensions fall back to
# image/png, matching the original inline dict. Hoisted from a per-call
# literal to module scope; it is only ever read via ``.get``.
_MIME_BY_EXT = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "gif": "image/gif",
}


def inject_image_attachments(
    job_id: str,
    messages: List[Dict[str, Any]],
    attachments: Optional[List[Dict[str, Any]]],
    workspace_dir: Path,
) -> None:
    """
    Attach base64 ``image_url`` parts to the LAST plain-text user message.

    MUTATES ``messages`` IN PLACE and returns None -- the caller keeps
    using the same list it passed to ``ContextManager.build_messages``.

    Only a message whose ``content`` is still a ``str`` is eligible; an
    already-multimodal message is skipped. The search walks backwards and
    stops at the first match, so exactly one message is ever converted.

    The original guard (``attachments and isinstance(messages, list) and
    messages``) is reproduced here so the call site stays a single line.
    """
    if not (attachments and isinstance(messages, list) and messages):
        return
    try:
        import base64 as _b64
        from peldrun.storage_paths import get_storage_root as _get_root

        _temp_dir = _get_root() / "artifacts" / "temp"

        _workspace_uploads_dir = None
        try:
            _workspace_uploads_dir = (
                workspace_dir / ".peldrun" / "user_uploads"
            )
        except Exception:
            _workspace_uploads_dir = None

        _image_parts: List[Dict[str, Any]] = []
        for _att in attachments:
            if not isinstance(_att, dict):
                continue
            _fid = _att.get("fileId") or _att.get("file_id")
            if not isinstance(_fid, str) or not _fid:
                continue
            # Path-traversal guard -- see module docstring.
            if "/" in _fid or "\\" in _fid or ".." in _fid:
                continue

            # Workspace FIRST, temp fallback. See module docstring.
            _path = None
            if _workspace_uploads_dir is not None:
                _ws_path = _workspace_uploads_dir / _fid
                if _ws_path.is_file():
                    _path = _ws_path
            if _path is None:
                _temp_path = _temp_dir / _fid
                if _temp_path.is_file():
                    _path = _temp_path
            if _path is None:
                logger.warning(
                    "[CHAT MULTIMODAL] fileId %r not found in "
                    "temp or workspace", _fid,
                )
                continue

            try:
                _raw = _path.read_bytes()
            except Exception as _read_exc:
                logger.warning(
                    "[CHAT MULTIMODAL] Failed to read %r: %s",
                    _fid, _read_exc,
                )
                continue

            _ext = _path.suffix.lower().lstrip(".")
            _mime = _MIME_BY_EXT.get(_ext, "image/png")
            _encoded = _b64.b64encode(_raw).decode("ascii")
            _image_parts.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:{_mime};base64,{_encoded}",
                    "detail": "auto",
                },
            })

        if _image_parts:
            for _i in range(len(messages) - 1, -1, -1):
                _msg = messages[_i]
                if (
                    isinstance(_msg, dict)
                    and _msg.get("role") == "user"
                    and isinstance(_msg.get("content"), str)
                ):
                    _text = _msg["content"]
                    _msg["content"] = (
                        [{"type": "text", "text": _text}]
                        + _image_parts
                    )
                    print(
                        f"[BRIDGE DIRECT CHAT] Injected "
                        f"{len(_image_parts)} multimodal image(s) "
                        f"for job {job_id}"
                    )
                    break
        else:
            print(
                f"[BRIDGE DIRECT CHAT] Multimodal attachments "
                f"present for job {job_id} but none resolved to "
                f"readable files."
            )
    except Exception as _mm_exc:
        logger.warning(
            "[BRIDGE DIRECT CHAT] Multimodal injection failed "
            "for job %s: %s",
            job_id, _mm_exc,
        )


async def append_image_gallery_block(
    result_text: str,
    images: Optional[List[Dict[str, Any]]],
    query: str,
    provider: str,
    job_id: str,
    *,
    chat_id: str = "",
    project_id: str = "",
    active_llm: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Append a fenced ``image_gallery`` block to the persisted result text.

    Chat mode does not render the SSE timeline, so the IMAGE_RESULTS
    event alone is lost on refresh. Embedding the proxied image list in
    the result markdown lets the frontend's MarkdownRenderer rebuild the
    gallery from persisted history.

    v3: When ``cards_auto_images`` is enabled, this function ALSO resolves
    the ``image.query`` strings emitted by the model inside ```ui blocks
    BEFORE serializing the gallery. Resolved images are appended to
    ``gallery_images`` and recorded in ``query_map`` so the frontend can
    map a card's ``image.query`` to a concrete image. Resolution is
    bounded (see ``card_images``) and happens AFTER the model's text is
    complete but BEFORE the ``final`` SSE event — so the frontend sees
    cards without images while streaming, then the full set at ``final``.

    ``ensure_ascii=False`` is deliberate: image titles are frequently
    non-Latin and escaping them would bloat the payload and break the
    renderer's title display.

    Returns ``result_text`` unchanged when there are no images (neither
    from the manual search nor from the auto-image resolution) or when
    serialization fails.
    """
    # v3: start from the caller's gallery so card resolution can append
    # to it. Using `or []` here (rather than an early `return`) is what
    # lets cards_auto_images populate the gallery even when the user did
    # NOT press the manual search button.
    gallery_images: List[Dict[str, Any]] = list(images or [])
    gallery_query_map: Dict[str, int] = {}
    used_in_cards: bool = False

    try:
        from peldrun.context.generative_ui import (
            cards_auto_images_enabled,
            cards_enabled,
        )

        # Two-dot import: chat_media is in `agent_bridge_parts/dispatcher/`,
        # card_images lives one level up in `agent_bridge_parts/`.
        from ..card_images import resolve_card_images, uses_card_refs

        _genui = (active_llm or {}).get("generative_ui")

        if cards_auto_images_enabled(_genui):
            # Full resolution path: the model may have written image.query
            # for cards that need a photo lookup. Bounded by card_images.
            gallery_images, gallery_query_map, used_in_cards = (
                await resolve_card_images(
                    result_text,
                    gallery_images,
                    run_id=job_id,
                    job_id=job_id,
                    chat_id=chat_id,
                    project_id=project_id,
                )
            )
        elif cards_enabled(_genui):
            # Ref-only path: no search allowed, but we still need to know
            # whether the model actually used the gallery refs so the
            # frontend can hide the gallery when it did.
            used_in_cards = uses_card_refs(result_text)
    except Exception as exc:
        logger.warning(
            "[CARD-IMAGES] skipped for job %s: %s", job_id, exc,
        )

    if not gallery_images:
        return result_text

    try:
        import json as _json_mod
        _gallery: Dict[str, Any] = {
            "images": gallery_images,
            "query": query,
            "provider": provider,
        }
        if gallery_query_map:
            _gallery["query_map"] = gallery_query_map
        if used_in_cards:
            # The frontend hides the gallery when this flag is set but
            # keeps `query_map` / `byRef` available for card resolution.
            _gallery["used_in_cards"] = True
        _gallery_payload = _json_mod.dumps(_gallery, ensure_ascii=False)
        return (
            result_text
            + f"\n\n```image_gallery\n{_gallery_payload}\n```\n"
        )
    except Exception as _gal_err:
        logger.debug(
            "[BRIDGE DIRECT CHAT] Failed to append image_gallery "
            "block for job %s: %s",
            job_id,
            _gal_err,
        )
        return result_text


__all__ = [
    "inject_image_attachments",
    "append_image_gallery_block",
]

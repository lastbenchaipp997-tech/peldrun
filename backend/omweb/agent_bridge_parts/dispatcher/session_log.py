# backend/omweb/agent_bridge_parts/dispatcher/session_log.py
"""
Per-session on-disk chat log for the PELDRUN Universal Agent Bridge.

Extracted from ``dispatcher.py``. Behavior preserved verbatim, including
the exact whitespace normalization and the dual-target write.

FORMAT CONTRACT (byte-exact)
----------------------------
    [<YYYY-MM-DD HH:MM:SS>] [<LOG_TYPE_UPPER>] <single-line message>\n

``clean_msg`` collapses CRLF first, then LF, each into ONE space. The
order matters: collapsing LF first would leave a stray CR behind on
Windows-authored messages. Do not change the replacement string to two
spaces or reorder the two ``replace`` calls -- existing chat.log files
and any log parser depend on this shape.

DUAL-TARGET WRITE
-----------------
The line is appended to BOTH:
  1. ``project_manager.get_chat_dir(chat_id, project_id)`` -- the
     project-scoped location (best-effort; skipped if it raises).
  2. ``project_manager.chats_dir / chat_id`` -- the legacy location.

Both are written on purpose: installations predating project scoping
still read location 2. Each write has its OWN try/except so a failure in
one target never prevents the other.

FAILURE SEMANTICS
-----------------
Never raises. Logging is observability, not a run dependency: every
failure path ends in ``logger.debug``. The outer try/except also covers
``project_manager.chats_dir`` access, which is why target 2 is appended
INSIDE the outer try rather than before it.

IMPORT NOTE
-----------
``project_manager`` is imported at module scope, exactly as the legacy
dispatcher did. This keeps the failure mode identical (a broken
project_manager surfaces at import, not silently at first log call) and
keeps ``session_log.project_manager`` patchable in tests.
"""
from __future__ import annotations

import logging
from typing import Any

from omweb.project_manager import project_manager

logger = logging.getLogger(__name__)


def append_session_log(
    chat_id: str,
    project_id: str,
    log_type: str,
    message: Any,
) -> None:
    """
    Append a structured line to chat.log on disk for the active session.

    No-op when ``chat_id`` is falsy or ``message`` is falsy. Note that
    ``message=0`` and ``message=""`` are therefore both skipped -- this
    is the original guard and is preserved deliberately.
    """
    if not chat_id or not message:
        return
    try:
        from datetime import datetime
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        clean_msg = str(message).strip().replace("\r\n", " ").replace("\n", " ")
        line = f"[{ts}] [{str(log_type).upper()}] {clean_msg}\n"

        target_dirs = []
        try:
            target_dirs.append(project_manager.get_chat_dir(chat_id, project_id))
        except Exception:
            pass

        target_dirs.append(project_manager.chats_dir / chat_id)

        for d in target_dirs:
            try:
                d.mkdir(parents=True, exist_ok=True)
                log_file = d / "chat.log"
                with open(log_file, "a", encoding="utf-8") as f:
                    f.write(line)
            except Exception as e:
                logger.debug(f"Failed writing chat.log in {d}: {e}")
    except Exception as exc:
        logger.debug(f"Failed to record session log for chat {chat_id}: {exc}")


__all__ = ["append_session_log"]

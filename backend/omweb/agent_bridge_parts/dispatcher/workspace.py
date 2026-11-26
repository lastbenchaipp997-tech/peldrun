# backend/omweb/agent_bridge_parts/dispatcher/workspace.py
"""
Shared project-workspace resolution for BOTH dispatch modes.

FIRST REAL DE-DUPLICATION OF THE SPLIT
--------------------------------------
``run_instrumented`` (agent) and ``run_direct_chat`` (chat) each carried
their own copy of this logic -- identical apart from the log prefix.
Two copies of a filesystem-path decision is exactly how the modes drift
apart: a file attached in agent mode becomes invisible to the next chat
turn. This module is now the single authority.

CORE INVARIANT
--------------
    Session Files (per-chat, ephemeral)  !=  Project Workspace
                                             (per-project, persistent,
                                              shared)

Every chat inside a project MUST resolve to the SAME directory.

RESOLUTION ORDER (unchanged)
----------------------------
  1. ``workspace_type == "external"`` AND a non-empty ``workspace_path``
     -> that path, ``expanduser()`` applied. NOT resolved to an absolute
     path beyond that, matching the original.
  2. Any real project id (not ``default_project``)
     -> ``projects_dir/<project_id>/workspace``.
  3. No project context (``default_project`` / legacy chat)
     -> the per-chat ``files/`` directory (legacy behavior preserved).

The directory is created (``parents=True, exist_ok=True``) in every
branch, including the external one.

WHY LOGGING IS A SEPARATE FUNCTION
----------------------------------
Resolution is a pure path decision plus mkdir; it emits no logs, so it
can be unit-tested without log capture. The log line lives in
``log_workspace_resolution`` and takes the mode prefix explicitly, so
both modes emit the SAME structure with their own historical prefix:

    agent -> "[BRIDGE] Workspace for job ..."
    chat  -> "[BRIDGE DIRECT CHAT] Workspace for job ..."

CALLER CONTRACT: dispatch modules MUST call BOTH functions, in that
order, immediately after resolving chat_id / project_id.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Tuple

from omweb.project_manager import project_manager

logger = logging.getLogger(__name__)

# Sentinel project id used when a chat has no project context. Chats
# under this id fall back to per-chat storage instead of a shared
# project workspace.
DEFAULT_PROJECT_ID = "default_project"


def resolve_project_workspace(chat_id: str, project_id: str) -> Tuple[Path, str]:
    """
    Resolve (and create) the shared workspace directory for a chat.

    Returns
    -------
    tuple[Path, str]
        ``(workspace_dir, workspace_type)``. ``workspace_type`` is the
        lowercased project setting, or ``"internal"`` when unset. It is
        returned because both dispatch modes log it; recomputing it at
        the call site would re-read the project metadata.

    Raises
    ------
    Whatever ``mkdir`` raises (e.g. PermissionError on an unreachable
    external path). The original code did not guard this either -- the
    failure propagates to the dispatch error handler, which is the
    correct behavior: running against a non-existent workspace would
    silently lose user files.
    """
    project_meta = project_manager.get_project(project_id) or {}
    ws_type = (project_meta.get("workspace_type") or "internal").lower()
    ws_cfg = (project_meta.get("workspace_path") or "").strip()

    if ws_type == "external" and ws_cfg:
        workspace_dir = Path(ws_cfg).expanduser()
    elif project_id and project_id != DEFAULT_PROJECT_ID:
        workspace_dir = project_manager.projects_dir / project_id / "workspace"
    else:
        workspace_dir = project_manager.get_chat_files_dir(chat_id, project_id)

    workspace_dir.mkdir(parents=True, exist_ok=True)
    return (workspace_dir, ws_type)


def log_workspace_resolution(
    job_id: str,
    workspace_dir: Path,
    project_id: str,
    workspace_type: str,
    *,
    mode_prefix: str,
) -> None:
    """
    Emit the workspace-resolution INFO line for the given mode.

    ``mode_prefix`` must be ``"[BRIDGE]"`` for agent mode or
    ``"[BRIDGE DIRECT CHAT]"`` for chat mode. The rendered message is
    byte-identical to the two original inline log calls.
    """
    logger.info(
        f"{mode_prefix} Workspace for job %s resolved to %s "
        "(project=%s, type=%s)",
        job_id,
        workspace_dir,
        project_id,
        workspace_type,
    )


__all__ = [
    "DEFAULT_PROJECT_ID",
    "resolve_project_workspace",
    "log_workspace_resolution",
]

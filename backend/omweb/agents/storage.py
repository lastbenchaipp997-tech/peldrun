# backend/omweb/agents/storage.py
"""
Agent Storage -- secure extraction and disk lifecycle for agent packages.

Handles the on-disk layout for agents installed from the catalog (ZIP
packages). Mirrors the safety guarantees of ``omweb.skills.storage``:

* ZIP extraction is staged in a temporary directory first.
* Path traversal (Zip Slip) is rejected before any file touches disk.
* A manifest.json MUST exist at the package root with a valid structure.
* An ``.installed.json`` sidecar records provenance (source, version).
* Atomic commit: the staging dir is renamed into place in one operation.
* Orphan cleanup removes stale staging/trash dirs from crashed runs.

Disk layout under ``backend/storage/store/agents/``:

    agents/
    ├── agents_state.json          # shared state file (managed by registry)
    ├── agent_settings.json        # shared settings file (managed by registry)
    ├── my_custom_agent.json       # legacy flat-file custom agent
    ├── catalog_agent_one/         # catalog-installed agent (directory)
    │   ├── manifest.json          # the authoritative agent manifest
    │   ├── .installed.json        # provenance sidecar
    │   └── ...                    # optional extra assets (icons, prompts)
    ├── .tmp_staging_xxxx/         # transient staging (cleaned on startup)
    └── .trash_xxxx/               # transient trash (cleaned on startup)

Design invariants:
* The registry NEVER mutates files in this directory directly for
  catalog agents -- all mutations go through this module.
* Flat-file agents (legacy) remain managed by the registry as before.
* Only directory-based agents use this storage layer.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("omweb.agents.storage")

# -- Constants ------------------------------------------------------

INSTALLED_META_FILENAME = ".installed.json"
MANIFEST_FILENAME = "manifest.json"
STAGING_PREFIX = ".tmp_staging_"
TRASH_PREFIX = ".trash_"

# Hard cap on total extracted size (defense against zip bombs).
MAX_EXTRACTED_BYTES = 100 * 1024 * 1024  # 100 MB
MAX_FILE_COUNT = 200  # max files in a single agent package


# -- Errors ---------------------------------------------------------


class AgentStorageError(Exception):
    """Base error for agent storage operations."""

    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.details = details or {}


class AgentManifestError(AgentStorageError):
    """The agent manifest is missing or structurally invalid."""


class AgentSecurityError(AgentStorageError):
    """A security check failed (path traversal, size limit, etc.)."""


# -- Result types ---------------------------------------------------


@dataclass
class AgentInstallResult:
    """Outcome of a successful agent installation."""

    agent_id: str
    version: str
    was_upgrade: bool = False
    warnings: List[str] = field(default_factory=list)
    package_dir: str = ""


# -- AgentStorage ---------------------------------------------------


class AgentStorage:
    """
    Manages the on-disk lifecycle of directory-based agent packages.

    All operations are synchronous. The catalog's async layer wraps
    calls to this class via ``asyncio.to_thread``.
    """

    def __init__(self, agents_dir: Path) -> None:
        self.agents_dir = agents_dir
        self.agents_dir.mkdir(parents=True, exist_ok=True)

    # -- Public API ---------------------------------------------------

    def install_agent_zip(
        self,
        zip_bytes: bytes,
        *,
        source_filename: str = "agent.zip",
        source: str = "catalog",
    ) -> AgentInstallResult:
        """
        Install an agent package from a ZIP payload.

        Flow:
            1. Validate and extract into a staging directory.
            2. Read and validate manifest.json.
            3. Determine if this is an upgrade (existing version).
            4. Atomically move staging -> final location.
            5. Write the .installed.json sidecar.
            6. Clean up staging on failure.

        Raises AgentStorageError (or subclass) on any failure.
        """
        staging_dir: Optional[Path] = None
        try:
            # 1. Extract into staging
            staging_dir = self._extract_to_staging(zip_bytes)

            # 2. Validate manifest
            manifest = self._read_and_validate_manifest(staging_dir)
            agent_id = manifest["id"]
            version = str(manifest.get("version", "0.0.0"))

            # 3. Determine upgrade status
            final_dir = self.agents_dir / agent_id
            was_upgrade = final_dir.exists()

            # 4. If upgrading, move old version to trash first
            if was_upgrade:
                self._move_to_trash(final_dir)

            # 5. Atomic commit: rename staging -> final
            staging_dir.rename(final_dir)
            staging_dir = None  # no longer needs cleanup

            # 6. Write provenance sidecar
            self._write_installed_meta(
                final_dir,
                source=source,
                source_filename=source_filename,
                version=version,
            )

            logger.info(
                "Agent %r v%s installed successfully (upgrade=%s, source=%s).",
                agent_id,
                version,
                was_upgrade,
                source,
            )

            return AgentInstallResult(
                agent_id=agent_id,
                version=version,
                was_upgrade=was_upgrade,
                package_dir=str(final_dir),
            )

        except Exception:
            # Clean up staging on any failure
            if staging_dir is not None and staging_dir.exists():
                shutil.rmtree(staging_dir, ignore_errors=True)
            raise

    def delete_agent(self, agent_id: str) -> bool:
        """
        Remove a directory-based agent package.
        Moves to trash first (recoverable until cleanup), then returns True.
        Returns False if the agent directory does not exist.
        """
        target = self.agents_dir / agent_id
        if not target.is_dir():
            return False

        self._move_to_trash(target)
        logger.info("Agent %r moved to trash.", agent_id)
        return True

    def get_installed_meta(self, agent_id: str) -> Optional[Dict[str, Any]]:
        """Read the .installed.json sidecar for a catalog agent."""
        meta_path = self.agents_dir / agent_id / INSTALLED_META_FILENAME
        if not meta_path.is_file():
            return None
        try:
            return json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            return None

    def cleanup_orphan_temp_dirs(self) -> int:
        """Remove stale staging directories from crashed installs."""
        removed = 0
        for entry in self.agents_dir.iterdir():
            if entry.is_dir() and entry.name.startswith(STAGING_PREFIX):
                shutil.rmtree(entry, ignore_errors=True)
                removed += 1
                logger.info("Cleaned orphan staging dir: %s", entry.name)
        return removed

    def cleanup_orphan_trash_dirs(self) -> int:
        """Remove stale trash directories from crashed deletes/upgrades."""
        removed = 0
        for entry in self.agents_dir.iterdir():
            if entry.is_dir() and entry.name.startswith(TRASH_PREFIX):
                shutil.rmtree(entry, ignore_errors=True)
                removed += 1
                logger.info("Cleaned orphan trash dir: %s", entry.name)
        return removed

    def list_package_agents(self) -> List[Dict[str, Any]]:
        """
        Discover all directory-based agents in the storage directory.
        Returns a list of manifest dicts with added metadata.
        Flat-file .json agents are NOT included here (the registry
        handles those directly).
        """
        agents: List[Dict[str, Any]] = []
        if not self.agents_dir.exists():
            return agents

        for entry in sorted(self.agents_dir.iterdir()):
            if not entry.is_dir():
                continue
            if entry.name.startswith("."):
                continue
            manifest_path = entry / MANIFEST_FILENAME
            if not manifest_path.is_file():
                continue
            try:
                data = json.loads(manifest_path.read_text(encoding="utf-8"))
                if not isinstance(data, dict):
                    continue
                # Structural validation: must have system_prompt
                sp = data.get("system_prompt")
                if not isinstance(sp, str) or not sp.strip():
                    continue

                aid = data.get("id") or entry.name
                data["id"] = aid
                data["is_builtin"] = False
                data["is_package"] = True

                # Read sidecar for source info
                meta = self.get_installed_meta(aid)
                if meta:
                    data["source"] = meta.get("source", "uploaded")
                    data["installed_version"] = meta.get("version", "0.0.0")
                else:
                    data["source"] = "uploaded"

                agents.append(data)
            except Exception as exc:
                logger.warning(
                    "Skipping malformed agent package %s: %s",
                    entry.name,
                    exc,
                )
                continue

        return agents

    # -- Internal helpers -----------------------------------------------

    def _extract_to_staging(self, zip_bytes: bytes) -> Path:
        """
        Safely extract a ZIP into a staging directory.
        Enforces:
        * Path traversal protection (Zip Slip).
        * Total extracted size cap.
        * File count cap.
        """
        staging = self.agents_dir / (
            STAGING_PREFIX + os.urandom(8).hex()
        )
        staging.mkdir(parents=True, exist_ok=True)

        total_bytes = 0
        file_count = 0

        try:
            with zipfile.ZipFile(zip_bytes) as zf:
                for info in zf.infolist():
                    # Skip directories
                    if info.is_dir():
                        continue

                    file_count += 1
                    if file_count > MAX_FILE_COUNT:
                        raise AgentSecurityError(
                            f"Agent package exceeds {MAX_FILE_COUNT} file limit.",
                            details={"file_count": file_count},
                        )

                    # Path traversal check
                    member_path = (staging / info.filename).resolve()
                    staging_resolved = staging.resolve()
                    if not str(member_path).startswith(str(staging_resolved)):
                        raise AgentSecurityError(
                            f"Path traversal detected: {info.filename!r}",
                            details={"filename": info.filename},
                        )

                    # Size check
                    total_bytes += info.file_size
                    if total_bytes > MAX_EXTRACTED_BYTES:
                        raise AgentSecurityError(
                            f"Agent package exceeds {MAX_EXTRACTED_BYTES} "
                            f"byte extracted size limit.",
                            details={"total_bytes": total_bytes},
                        )

                    # Extract safely
                    member_path.parent.mkdir(parents=True, exist_ok=True)
                    with zf.open(info) as src, open(member_path, "wb") as dst:
                        shutil.copyfileobj(src, dst)

        except zipfile.BadZipFile as exc:
            shutil.rmtree(staging, ignore_errors=True)
            raise AgentStorageError(
                f"Invalid ZIP archive: {exc}",
                details={"reason": "bad_zip"},
            ) from exc
        except AgentStorageError:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        except Exception as exc:
            shutil.rmtree(staging, ignore_errors=True)
            raise AgentStorageError(
                f"Extraction failed: {exc}",
                details={"reason": "extraction_error"},
            ) from exc

        return staging

    def _read_and_validate_manifest(
        self, staging_dir: Path
    ) -> Dict[str, Any]:
        """
        Read manifest.json from the staging directory and validate
        its structure. Raises AgentManifestError on failure.
        """
        manifest_path = staging_dir / MANIFEST_FILENAME
        if not manifest_path.is_file():
            raise AgentManifestError(
                f"Agent package is missing {MANIFEST_FILENAME} at root.",
                details={"reason": "missing_manifest"},
            )

        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise AgentManifestError(
                f"manifest.json is not valid JSON: {exc}",
                details={"reason": "invalid_json"},
            ) from exc

        if not isinstance(data, dict):
            raise AgentManifestError(
                "manifest.json root must be a JSON object.",
                details={"reason": "not_object"},
            )

        # Required fields
        agent_id = data.get("id")
        if not isinstance(agent_id, str) or not agent_id.strip():
            raise AgentManifestError(
                "manifest.json must declare a non-empty 'id' field.",
                details={"reason": "missing_id"},
            )

        system_prompt = data.get("system_prompt")
        if not isinstance(system_prompt, str) or not system_prompt.strip():
            raise AgentManifestError(
                "manifest.json must declare a non-empty 'system_prompt'.",
                details={"reason": "missing_system_prompt"},
            )

        # Normalize: ensure id is filesystem-safe
        safe_id = self._sanitize_agent_id(agent_id)
        data["id"] = safe_id

        # Write back normalized manifest
        manifest_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

        return data

    @staticmethod
    def _sanitize_agent_id(raw_id: str) -> str:
        """
        Convert an agent ID to a filesystem-safe canonical form.
        Lowercase, alphanumeric + underscores + hyphens only.
        """
        import re
        sanitized = raw_id.strip().lower()
        sanitized = sanitized.replace(" ", "_")
        sanitized = re.sub(r"[^a-z0-9_\-]", "", sanitized)
        if not sanitized:
            raise AgentManifestError(
                f"Agent ID '{raw_id}' sanitizes to empty string.",
                details={"reason": "empty_id_after_sanitize"},
            )
        return sanitized

    def _write_installed_meta(
        self,
        package_dir: Path,
        *,
        source: str,
        source_filename: str,
        version: str,
    ) -> None:
        """Write the .installed.json provenance sidecar."""
        meta = {
            "source": source,
            "source_filename": source_filename,
            "version": version,
            "installed_at": datetime.now(timezone.utc).isoformat(),
        }
        meta_path = package_dir / INSTALLED_META_FILENAME
        meta_path.write_text(
            json.dumps(meta, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

    def _move_to_trash(self, target: Path) -> None:
        """
        Move a directory to a trash location for safe cleanup.
        Trash dirs are removed by cleanup_orphan_trash_dirs().
        """
        trash_name = TRASH_PREFIX + os.urandom(8).hex()
        trash_path = self.agents_dir / trash_name
        try:
            target.rename(trash_path)
        except OSError:
            # Cross-device fallback: copy then remove
            shutil.copytree(target, trash_path)
            shutil.rmtree(target, ignore_errors=True)

# backend/omweb/agents/catalog/__init__.py
"""
Agent Catalog package.

Provides remote + local catalog discovery and one-click install
for agent packages. Mirrors the architecture of
``omweb.skills.catalog`` and ``omweb.provider_packages.catalog``.

Public API:
    - AgentCatalogItem: Pydantic schema for a catalog entry.
    - AgentCatalog: Merged catalog with remote fetch + install.
    - get_agent_catalog(): Process-wide singleton accessor.
    - is_installable / installability_reason: Install gate helpers.
"""

from omweb.agents.catalog.schema import (
    AgentCatalogItem,
    DeveloperInfo,
    installability_reason,
    is_installable,
)
from omweb.agents.catalog.catalog import (
    AgentCatalog,
    get_agent_catalog,
    reset_agent_catalog_for_tests,
    BUILTIN_CATALOG_FILENAME,
    CUSTOM_CATALOG_ENV_VAR,
    DEFAULT_REMOTE_CATALOG_URL,
    ENABLED_ENV_VAR,
    REMOTE_CATALOG_CACHE_FILENAME,
    REMOTE_CATALOG_ENV_VAR,
    REMOTE_CATALOG_NEGATIVE_TTL_SECONDS,
    REMOTE_CATALOG_TTL_SECONDS,
)

__all__ = [
    # Schema
    "AgentCatalogItem",
    "DeveloperInfo",
    "is_installable",
    "installability_reason",
    # Catalog
    "AgentCatalog",
    "get_agent_catalog",
    "reset_agent_catalog_for_tests",
    # Constants
    "BUILTIN_CATALOG_FILENAME",
    "CUSTOM_CATALOG_ENV_VAR",
    "DEFAULT_REMOTE_CATALOG_URL",
    "ENABLED_ENV_VAR",
    "REMOTE_CATALOG_CACHE_FILENAME",
    "REMOTE_CATALOG_ENV_VAR",
    "REMOTE_CATALOG_NEGATIVE_TTL_SECONDS",
    "REMOTE_CATALOG_TTL_SECONDS",
]

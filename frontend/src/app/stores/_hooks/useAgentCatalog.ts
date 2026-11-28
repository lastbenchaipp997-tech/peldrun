// frontend/src/app/stores/_hooks/useAgentCatalog.ts
"use client";

import { useCallback, useState } from "react";
import type {
  AgentCatalogBackendInstallState,
  AgentCatalogItem,
  AgentCatalogInstallState,
  AgentCatalogListResponse,
  CatalogAgentInstallResult,
} from "../_types/store";
import { getApiUrl } from "./useStoreData";

/**
 * Error type for agent catalog API failures.
 * Carries the structured backend error shape {error, code, details}.
 */
export class AgentCatalogApiError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AgentCatalogApiError";
    this.code = code || "UNKNOWN";
    this.details = details || {};
  }
}

/**
 * Hook for managing the Agent Catalog state and actions.
 * Mirrors the pattern from useSkillActions for catalog operations.
 */
export function useAgentCatalog(onReloadAgents?: () => void | Promise<void>) {
  // ── Catalog state ─────────────────────────────────────────────
  const [catalogItems, setCatalogItems] = useState<AgentCatalogItem[]>([]);
  const [isCatalogLoading, setIsCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [isCatalogRefreshing, setIsCatalogRefreshing] = useState(false);

  // ── Install state ─────────────────────────────────────────────
  const [installingCatalogId, setInstallingCatalogId] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<CatalogAgentInstallResult | null>(null);

  // ── Details modal state ───────────────────────────────────────
  const [detailsItem, setDetailsItem] = useState<AgentCatalogItem | null>(null);
  const [installModalItem, setInstallModalItem] = useState<AgentCatalogItem | null>(null);

  /**
   * Fetch the agent catalog from the backend.
   * Called lazily when the Catalog tab is first opened.
   */
  const fetchCatalog = useCallback(async () => {
    setIsCatalogLoading(true);
    setCatalogError(null);
    try {
      const res = await fetch(getApiUrl("/api/store/agents/catalog"));
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new AgentCatalogApiError(
          err.detail?.error || `HTTP ${res.status}`,
          err.detail?.code,
          err.detail?.details
        );
      }
      const data: AgentCatalogListResponse = await res.json();
      setCatalogItems(data.items || []);
    } catch (exc) {
      const msg =
        exc instanceof AgentCatalogApiError
          ? exc.message
          : exc instanceof Error
            ? exc.message
            : "Failed to load agent catalog";
      setCatalogError(msg);
    } finally {
      setIsCatalogLoading(false);
    }
  }, []);

  /**
   * Force-refresh the remote catalog, bypassing the TTL cache.
   * Used by the "Refresh" button in the catalog tab header.
   */
  const refreshCatalog = useCallback(async () => {
    setIsCatalogRefreshing(true);
    setCatalogError(null);
    try {
      const res = await fetch(getApiUrl("/api/store/agents/catalog/refresh"), {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new AgentCatalogApiError(
          err.detail?.error || `HTTP ${res.status}`,
          err.detail?.code,
          err.detail?.details
        );
      }
      // Re-fetch the catalog list after refresh
      await fetchCatalog();
    } catch (exc) {
      const msg =
        exc instanceof AgentCatalogApiError
          ? exc.message
          : exc instanceof Error
            ? exc.message
            : "Failed to refresh agent catalog";
      setCatalogError(msg);
    } finally {
      setIsCatalogRefreshing(false);
    }
  }, [fetchCatalog]);

  /**
   * Install a catalog agent.
   * Downloads, verifies SHA-256, and saves the manifest.
   */
  const installFromCatalog = useCallback(
    async (item: AgentCatalogItem) => {
      setInstallingCatalogId(item.id);
      setInstallResult(null);
      try {
        const res = await fetch(
          getApiUrl(`/api/store/agents/catalog/${encodeURIComponent(item.id)}/install`),
          { method: "POST" }
        );

        const data = await res.json();

        if (!res.ok) {
          const detail = data.detail || {};
          throw new AgentCatalogApiError(
            detail.error || `HTTP ${res.status}`,
            detail.code,
            detail.details
          );
        }

        // Success
        const agent = data.agent || {};
        setInstallResult({
          success: true,
          agentId: agent.id || item.id,
          version: agent.version || item.version,
          name: agent.name || item.display_name || item.name,
        });

        // Reload the agents list so the new agent appears
        if (onReloadAgents) {
          await onReloadAgents();
        }

        // Update the catalog item's install state to reflect the
        // newly installed agent. Uses the backend snake_case shape
        // (AgentCatalogBackendInstallState) since that is what
        // AgentCatalogItem.install_state is typed as.
        setCatalogItems((prev) =>
          prev.map((ci): AgentCatalogItem =>
            ci.id === item.id
              ? {
                  ...ci,
                  install_state: {
                    is_installed: true,
                    installed_version: agent.version || item.version,
                    has_update: false,
                    is_builtin: false,
                    blocked_reason: null,
                  },
                }
              : ci
          )
        );
      } catch (exc) {
        const msg =
          exc instanceof AgentCatalogApiError
            ? exc.message
            : exc instanceof Error
              ? exc.message
              : "Install failed unexpectedly";
        const code =
          exc instanceof AgentCatalogApiError ? exc.code : "UNKNOWN";
        setInstallResult({
          success: false,
          error: msg,
          code,
        });
      } finally {
        setInstallingCatalogId(null);
      }
    },
    [onReloadAgents]
  );

  /**
   * Compute the install state for a catalog item by matching
   * against the installed agents array.
   */
  const computeInstallState = useCallback(
    (
      item: AgentCatalogItem,
      installedAgents: Array<{ id: string; version?: string; is_builtin?: boolean; status?: string }>
    ): AgentCatalogInstallState => {
      // Use backend-provided install_state if available.
      // The backend shape (AgentCatalogBackendInstallState) uses
      // snake_case; we map it to the frontend shape here.
      if (item.install_state) {
        const backendState = item.install_state;
        return {
          isInstalled: backendState.is_installed,
          isEnabled: true, // Agents don't have disabled state in catalog context
          installedVersion: backendState.installed_version,
          installedAgent: installedAgents.find(
            (a) => a.id.toLowerCase() === item.id.toLowerCase()
          ) || null,
        };
      }

      // Fallback: compute from installed agents
      const installed = installedAgents.find(
        (a) => a.id.toLowerCase() === item.id.toLowerCase()
      );

      if (!installed) {
        return {
          isInstalled: false,
          isEnabled: false,
          installedVersion: null,
          installedAgent: null,
        };
      }

      return {
        isInstalled: true,
        isEnabled: installed.status !== "disabled",
        installedVersion: installed.version || null,
        installedAgent: installed,
      };
    },
    []
  );

  // ── Modal handlers ────────────────────────────────────────────

  const openDetails = useCallback((item: AgentCatalogItem) => {
    setDetailsItem(item);
  }, []);

  const closeDetails = useCallback(() => {
    setDetailsItem(null);
  }, []);

  const openInstallModal = useCallback((item: AgentCatalogItem) => {
    setInstallModalItem(item);
    setInstallResult(null);
  }, []);

  const closeInstallModal = useCallback(() => {
    setInstallModalItem(null);
    setInstallResult(null);
  }, []);

  const clearInstallResult = useCallback(() => {
    setInstallResult(null);
  }, []);

  return {
    // Catalog state
    catalogItems,
    isCatalogLoading,
    catalogError,
    isCatalogRefreshing,

    // Install state
    installingCatalogId,
    installResult,

    // Modal state
    detailsItem,
    installModalItem,

    // Actions
    fetchCatalog,
    refreshCatalog,
    installFromCatalog,
    computeInstallState,

    // Modal handlers
    openDetails,
    closeDetails,
    openInstallModal,
    closeInstallModal,
    clearInstallResult,
  };
}

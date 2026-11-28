// frontend/src/app/stores/_sections/AgentsSection.tsx
"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Store,
} from "lucide-react";
import type { AgentManifest } from "@/lib/types";
import { AgentCard } from "../_components/AgentCard";
import { CatalogAgentCard } from "../_components/CatalogAgentCard";
import {
  AgentDetailsModal,
  type AgentWithMeta,
} from "../_modals/AgentDetailsModal";
import { AgentSettingsModal } from "../_modals/AgentSettingsModal";
import { AgentToolsModal } from "../_modals/AgentToolsModal";
import { AgentMcpModal } from "../_modals/AgentMcpModal";
import { AgentSkillsModal } from "../_modals/AgentSkillsModal";
import { getApiUrl } from "../_hooks/useStoreData";
import { useAgentCatalog } from "../_hooks/useAgentCatalog";
import type { SectionHeaderConfig } from "../_config/sections";
import type { AgentFilter } from "../_types/store";

/**
 * Active tab within the Agents section.
 * "installed" — local agents (builtin + custom + catalog-installed)
 * "catalog"   — remote catalog items available for one-click install
 */
type AgentsTab = "installed" | "catalog";

export interface AgentsSectionProps {
  agents: AgentManifest[];
  searchQuery: string;
  agentFilter: AgentFilter;
  togglingAgentId: string | null;
  onToggleAgent: (agentId: string) => void;
  onEditAgent: (agent: AgentManifest) => void;
  onDeleteAgent: (agentId: string) => void;
  onStartChat: (agent: AgentManifest) => void;
  onReloadAgents?: () => void | Promise<void>;
}

export function getAgentsHeaderConfig(ctx: {
  onNewAgent: () => void;
  onRefreshCatalog?: () => void;
  isCatalogRefreshing?: boolean;
  activeTab?: AgentsTab;
}): SectionHeaderConfig {
  const actions: SectionHeaderConfig["actions"] = [];

  // Show Refresh button only when the Catalog tab is active
  if (ctx.activeTab === "catalog" && ctx.onRefreshCatalog) {
    actions.push({
      id: "refresh-catalog",
      label: "Refresh",
      icon: RefreshCw,
      variant: "outline",
      onClick: ctx.onRefreshCatalog,
      loading: ctx.isCatalogRefreshing,
    });
  }

  actions.push({
    id: "new-agent",
    label: "New Agent",
    icon: Plus,
    variant: "primary",
    onClick: ctx.onNewAgent,
  });

  return {
    title: "Agents Hub",
    subtitle: "Autonomous personas and specialist agents",
    badge: "AGENTS",
    actions,
  };
}

async function fetchAgentManifest(
  agentId: string
): Promise<AgentWithMeta | null> {
  try {
    const res = await fetch(
      getApiUrl(`/api/store/agents/${encodeURIComponent(agentId)}`)
    );
    if (!res.ok) return null;
    const data = await res.json();
    const agent = data?.agent;
    return agent && typeof agent === "object"
      ? (agent as AgentWithMeta)
      : null;
  } catch {
    return null;
  }
}

export function AgentsSection({
  agents,
  searchQuery,
  agentFilter,
  togglingAgentId,
  onToggleAgent,
  onEditAgent,
  onDeleteAgent,
  onStartChat,
  onReloadAgents,
}: AgentsSectionProps) {
  // ── Tab state ──────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<AgentsTab>("installed");

  // ── Catalog hook ───────────────────────────────────────────────
  const {
    catalogItems,
    isCatalogLoading,
    catalogError,
    isCatalogRefreshing,
    installingCatalogId,
    fetchCatalog,
    refreshCatalog,
    installFromCatalog,
    computeInstallState,
    openDetails: openCatalogDetails,
    closeDetails: closeCatalogDetails,
    detailsItem: catalogDetailsItem,
    openInstallModal,
    closeInstallModal,
    installModalItem,
    installResult,
    clearInstallResult,
  } = useAgentCatalog(onReloadAgents);

  // Track whether catalog has been loaded at least once
  const [catalogLoaded, setCatalogLoaded] = useState(false);

  // Lazy-load catalog when the Catalog tab is first opened
  useEffect(() => {
    if (activeTab === "catalog" && !catalogLoaded) {
      setCatalogLoaded(true);
      fetchCatalog();
    }
  }, [activeTab, catalogLoaded, fetchCatalog]);

  // ── Installed agents modals ────────────────────────────────────
  const [detailsAgent, setDetailsAgent] = useState<AgentWithMeta | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [settingsAgent, setSettingsAgent] = useState<AgentWithMeta | null>(null);
  const [toolsAgent, setToolsAgent] = useState<AgentWithMeta | null>(null);
  const [skillsAgent, setSkillsAgent] = useState<AgentWithMeta | null>(null);
  const [mcpAgent, setMcpAgent] = useState<AgentWithMeta | null>(null);

  const openDetails = useCallback(async (agent: AgentManifest) => {
    const shortData = agent as AgentWithMeta;
    setDetailsAgent(shortData);
    setDetailsLoading(true);
    try {
      const full = await fetchAgentManifest(agent.id);
      setDetailsAgent((prev) =>
        prev && prev.id === agent.id && full
          ? ({ ...prev, ...full } as AgentWithMeta)
          : prev
      );
    } finally {
      setDetailsLoading(false);
    }
  }, []);

  const openSettings = useCallback((agent: AgentManifest) => {
    setSettingsAgent(agent as AgentWithMeta);
  }, []);

  const openTools = useCallback((agent: AgentManifest) => {
    setToolsAgent(agent as AgentWithMeta);
  }, []);

  const openSkills = useCallback((agent: AgentManifest) => {
    setSkillsAgent(agent as AgentWithMeta);
  }, []);

  const openMcp = useCallback((agent: AgentManifest) => {
    setMcpAgent(agent as AgentWithMeta);
  }, []);

  // ── Installed agents filtering ─────────────────────────────────
  const filteredAgents = useMemo(() => {
    return agents.filter((ag) => {
      const q = searchQuery.toLowerCase().trim();
      const matchesQuery =
        !q ||
        ag.name.toLowerCase().includes(q) ||
        (ag.description || "").toLowerCase().includes(q) ||
        (ag.role || "").toLowerCase().includes(q);

      if (!matchesQuery) return false;
      if (agentFilter === "builtin") return ag.is_builtin;
      if (agentFilter === "custom") return !ag.is_builtin;
      if (agentFilter === "active") return ag.status !== "disabled";
      if (agentFilter === "disabled") return ag.status === "disabled";
      return true;
    });
  }, [agents, searchQuery, agentFilter]);

  // ── Catalog filtering ──────────────────────────────────────────
  const filteredCatalogItems = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return catalogItems;
    return catalogItems.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        (item.display_name || "").toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  }, [catalogItems, searchQuery]);

  // ── Tab content: Installed ─────────────────────────────────────
  const renderInstalledTab = () => {
    if (filteredAgents.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center p-12 text-center rounded-2xl border border-dashed border-border bg-card/40">
          <Bot className="h-10 w-10 text-muted-foreground mb-3" />
          <h3 className="text-sm font-semibold text-foreground">
            No agents match your criteria
          </h3>
          <p className="text-xs text-muted-foreground max-w-sm mt-1">
            Try adjusting your search query or create a new custom agent.
          </p>
        </div>
      );
    }

    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {filteredAgents.map((ag) => (
          <AgentCard
            key={ag.id}
            agent={ag}
            isToggling={togglingAgentId === ag.id}
            onToggle={onToggleAgent}
            onEdit={onEditAgent}
            onDelete={onDeleteAgent}
            onStartChat={onStartChat}
            onViewDetails={openDetails}
            onOpenSettings={openSettings}
            onOpenTools={openTools}
            onOpenSkills={openSkills}
            onOpenMcp={openMcp}
          />
        ))}
      </div>
    );
  };

  // ── Tab content: Catalog ───────────────────────────────────────
  const renderCatalogTab = () => {
    // Loading state
    if (isCatalogLoading && catalogItems.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center p-16 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">
            Loading agent catalog…
          </p>
        </div>
      );
    }

    // Error state
    if (catalogError && catalogItems.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center p-12 text-center rounded-2xl border border-dashed border-destructive/30 bg-destructive/5">
          <Store className="h-10 w-10 text-muted-foreground mb-3" />
          <h3 className="text-sm font-semibold text-foreground">
            Failed to load catalog
          </h3>
          <p className="text-xs text-muted-foreground max-w-sm mt-1">
            {catalogError}
          </p>
          <button
            type="button"
            onClick={() => fetchCatalog()}
            className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </button>
        </div>
      );
    }

    // Empty state
    if (filteredCatalogItems.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center p-12 text-center rounded-2xl border border-dashed border-border bg-card/40">
          <Sparkles className="h-10 w-10 text-muted-foreground mb-3" />
          <h3 className="text-sm font-semibold text-foreground">
            No catalog agents available
          </h3>
          <p className="text-xs text-muted-foreground max-w-sm mt-1">
            The agent catalog is empty. Check back later or configure a
            custom catalog source.
          </p>
        </div>
      );
    }

    // Catalog items grid
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {filteredCatalogItems.map((item) => {
          const installState = computeInstallState(item, agents);
          return (
            <CatalogAgentCard
              key={item.id}
              item={item}
              installState={installState}
              isInstalling={installingCatalogId === item.id}
              onInstall={() => openInstallModal(item)}
              onOpenDetails={() => openCatalogDetails(item)}
              onOpenInstalled={() => {
                // Find the installed agent and open its details
                const installed = agents.find(
                  (a) => a.id.toLowerCase() === item.id.toLowerCase()
                );
                if (installed) {
                  openDetails(installed);
                }
              }}
            />
          );
        })}
      </div>
    );
  };

  // ── Main render ────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border pb-px">
        <button
          type="button"
          onClick={() => setActiveTab("installed")}
          className={[
            "relative flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors",
            activeTab === "installed"
              ? "text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-primary"
              : "text-muted-foreground hover:text-foreground",
          ].join(" ")}
        >
          <Bot className="h-3.5 w-3.5" />
          Installed
          <span className="p-2 flex items-center justify-center rounded-full w-[18px] h-[18px] bg-card shadow-sm px-1.5 py-0.5 text-[10px] font-semibold text-black">
            {agents.length}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("catalog")}
          className={[
            "relative flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors",
            activeTab === "catalog"
              ? "text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-primary"
              : "text-muted-foreground hover:text-foreground",
          ].join(" ")}
        >
          <Store className="h-3.5 w-3.5" />
          Catalog
          {isCatalogLoading ? (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          ) : (
            <span className="p-2 flex items-center justify-center rounded-full w-[18px] h-[18px] bg-card shadow-sm px-1.5 py-0.5 text-[10px] font-semibold text-black">
              {catalogItems.length}
            </span>
          )}
        </button>

        {/* Refresh button (catalog tab only) */}
        {activeTab === "catalog" && (
          <button
            type="button"
            onClick={() => refreshCatalog()}
            disabled={isCatalogRefreshing}
            className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
            title="Force refresh from remote catalog"
          >
            <RefreshCw
              className={[
                "h-3 w-3",
                isCatalogRefreshing ? "animate-spin" : "",
              ].join(" ")}
            />
            Refresh
          </button>
        )}
      </div>

      {/* Tab content */}
      {activeTab === "installed" ? renderInstalledTab() : renderCatalogTab()}

      {/* ── Installed agent modals ──────────────────────────────── */}

      {/* Details modal */}
      <AgentDetailsModal
        open={detailsAgent !== null}
        agent={detailsAgent}
        loading={detailsLoading}
        onClose={() => {
          setDetailsAgent(null);
          setDetailsLoading(false);
        }}
      />

      {/* Settings modal */}
      <AgentSettingsModal
        open={settingsAgent !== null}
        agentId={settingsAgent?.id ?? null}
        agentName={settingsAgent?.name ?? ""}
        onClose={() => setSettingsAgent(null)}
      />

      {/* Tools modal */}
      <AgentToolsModal
        open={toolsAgent !== null}
        agentId={toolsAgent?.id ?? null}
        agentName={toolsAgent?.name ?? ""}
        onClose={() => setToolsAgent(null)}
      />

      {/* Skills modal */}
      <AgentSkillsModal
        open={skillsAgent !== null}
        agentId={skillsAgent?.id ?? null}
        agentName={skillsAgent?.name ?? ""}
        onClose={() => setSkillsAgent(null)}
        onSaved={onReloadAgents}
      />

      {/* MCP modal */}
      <AgentMcpModal
        open={mcpAgent !== null}
        agentId={mcpAgent?.id ?? null}
        agentName={mcpAgent?.name ?? ""}
        onClose={() => setMcpAgent(null)}
        onSaved={onReloadAgents}
      />

      {/* ── Catalog modals (placeholders until created) ─────────── */}
      {/* TODO: CatalogAgentDetailsModal */}
      {/* TODO: CatalogAgentInstallModal */}
    </div>
  );
}

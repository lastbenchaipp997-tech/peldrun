// frontend/src/app/settings/setup/Sidebar.tsx
"use client";

import React from "react";
import Link from "next/link";
import {
  Save,
  RefreshCw,
  Cpu,
  Globe,
  Search,
  Box,
  Share2,
  Info,
  RotateCcw,
  AlertCircle,
  Activity,
  ExternalLink,
  Coins,
  GitBranch,
  Blocks,
  Gauge,
  Sparkles,
  Brain,
  HardDrive,
  Monitor,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SettingsTab } from "./types";

interface SidebarProps {
  activeTab: SettingsTab;
  setActiveTab: (t: SettingsTab) => void;
  handleSave: () => void;
  handleReset: () => void;
  saving: boolean;
  isDirty: boolean;
  saveStatus: { ok: boolean; message: string } | null;
}

/**
 * A group of sidebar items. Groups may contain both:
 * - in-page tabs (switch activeTab, rendered as <button>)
 * - navigation links (route to another page, rendered as <Link>)
 * This keeps related concerns visually together while preserving
 * the distinct opening behaviour of each item.
 */
interface SidebarGroup {
  id: string;
  label: string;
  items: Array<SidebarTabItem | SidebarLinkItem>;
}

interface SidebarTabItem {
  kind: "tab";
  id: SettingsTab;
  label: string;
  icon: React.ReactNode;
}

interface SidebarLinkItem {
  kind: "link";
  href: string;
  label: string;
  title: string;
  icon: React.ReactNode;
  /** When true, the link points to an absolute external URL and opens in a new tab. */
  external?: boolean;
}

export function Sidebar({
  activeTab,
  setActiveTab,
  handleSave,
  handleReset,
  saving,
  isDirty,
  saveStatus,
}: SidebarProps) {
  const groups: SidebarGroup[] = [
    {
      id: "models-ai",
      label: "Models & AI",
      items: [
        { kind: "tab", id: "llm", label: "Model Hub [LLM]", icon: <Cpu size={14} /> },
        { kind: "tab", id: "usage", label: "Usage & Cost Analytics", icon: <Coins size={14} /> },
        { kind: "tab", id: "generative-ui", label: "Generative UI", icon: <Sparkles size={14} /> },
      ],
    },
    {
      id: "search-web",
      label: "Search & Web",
      items: [
        { kind: "tab", id: "search", label: "Search Engine", icon: <Search size={14} /> },
        {
          kind: "link",
          href: "/settings/search",
          label: "Search & Telemetry",
          title: "Open dedicated search orchestrator, analytics, and provider telemetry",
          icon: <Activity size={14} className="text-peldrun-accent" />,
        },
      ],
    },
    {
      id: "runtime-execution",
      label: "Runtime & Execution",
      items: [
        { kind: "tab", id: "browser", label: "Browser & CDP", icon: <Globe size={14} /> },
        { kind: "tab", id: "sandbox", label: "Docker & Daytona", icon: <Box size={14} /> },
      ],
    },
    {
      id: "agents-integrations",
      label: "Agents & Integrations",
      items: [
        { kind: "tab", id: "mcp", label: "MCP & Agents", icon: <Share2 size={14} /> },
        {
          kind: "link",
          href: "/integrations",
          label: "Integrations",
          title: "External integrations and connected services",
          icon: <Blocks size={14} />,
        },
        {
          kind: "link",
          href: "/source-control",
          label: "Source Control",
          title: "Manage version control and repository state",
          icon: <GitBranch size={14} />,
        },
      ],
    },
    {
      id: "system-diagnostics",
      label: "System & Diagnostics",
      items: [
        { kind: "tab", id: "system", label: "Diagnostics & HW", icon: <Info size={14} /> },
        {
          kind: "link",
          href: "/settings/runtime",
          label: "Runtime Settings",
          title: "Cleanup schedule, streaming cadence, live-editable",
          icon: <Gauge size={14} className="text-peldrun-accent" />,
        },
        {
          kind: "link",
          href: "/status",
          label: "System Health",
          title: "Open real-time system health and runtime diagnostics",
          icon: <Activity size={14} className="text-peldrun-accent" />,
        },
        {
          kind: "link",
          href: "http://localhost:3088/resource-monitor",
          label: "Resource Monitor",
          title: "Open the dedicated resource monitor dashboard",
          icon: <Monitor size={14} className="text-peldrun-accent" />,
          external: true,
        },
      ],
    },
    {
      id: "developer-tools",
      label: "Developer Tools",
      items: [
        {
          kind: "link",
          href: "/memory",
          label: "Memory Settings",
          title: "Memory allocation, caching policies, live-editable",
          icon: <HardDrive size={14} className="text-peldrun-accent" />,
        },
      ],
    },
  ];

  const renderTabItem = (item: SidebarTabItem) => {
    const isActive = activeTab === item.id;
    return (
      <button
        key={item.id}
        onClick={() => setActiveTab(item.id)}
        className={`w-full flex items-center justify-between px-3 py-2 rounded-0 text-xs font-medium transition-all cursor-pointer ${
          isActive
            ? "bg-custom text-primary shadow-peldrun-xs border-l-2 border-black"
            : "text-muted-foreground hover:text-foreground hover:bg-custom border-l border-card hover:border-black"
        }`}
      >
        <div className="flex items-center gap-2.5">
          {item.icon}
          <span>{item.label}</span>
        </div>
      </button>
    );
  };

  const renderLinkItem = (item: SidebarLinkItem) => {
    const className =
      "w-full flex items-center justify-between px-3 py-2 rounded-0 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-all cursor-pointer group";

    const content = (
      <>
        <div className="flex items-center gap-2.5">
          <span className="group-hover:scale-110 transition-transform inline-flex">
            {item.icon}
          </span>
          <span className="group-hover:text-foreground transition-colors">{item.label}</span>
        </div>
        <ExternalLink
          size={12}
          className="text-muted-foreground/50 group-hover:text-foreground transition-colors"
        />
      </>
    );

    // External services (e.g. a standalone resource monitor) open in a new tab
    // so the current settings UI state is preserved.
    if (item.external) {
      return (
        <a
          key={item.href}
          href={item.href}
          title={item.title}
          target="_blank"
          rel="noopener noreferrer"
          className={className}
        >
          {content}
        </a>
      );
    }

    return (
      <Link key={item.href} href={item.href} title={item.title} className={className}>
        {content}
      </Link>
    );
  };

  return (
    <div className="w-60 border-r border-card bg-sidebg flex flex-col p-0 pt-0 pb-4 space-y-1 shrink-0 select-none">
      {isDirty && (
        <span className="inline-flex items-center gap-1 mx-3 mt-2 text-[14px] font-medium text-red-100 bg-red-900/90 border border-red-500/20 px-1.5 py-0.5">
          <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
          Unsaved
        </span>
      )}

      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
          Configuration
        </span>
      </div>

      <div className="space-y-1 flex-1 overflow-y-auto">
        {groups.map((group, groupIndex) => (
          <div
            key={group.id}
            className={
              groupIndex > 0
                ? "pt-2.5 mt-2.5 border-t border-border/60"
                : ""
            }
          >
            <span className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider px-3 mb-1.5 block">
              {group.label}
            </span>

            {group.items.map((item) =>
              item.kind === "tab" ? renderTabItem(item) : renderLinkItem(item)
            )}
          </div>
        ))}
      </div>

      <div className="pl-3 pr-3 pt-3 border-t border-border space-y-2">
        <div className="flex items-center gap-2">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="primary flex-1 flex items-center justify-center gap-1.5 h-8 bg-primary text-primary-foreground hover:bg-primary/90 font-medium text-xs rounded-0 shadow-peldrun-xs cursor-pointer hover:opacity-90"
          >
            {saving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
            <span>{saving ? "Saving..." : "Save Config"}</span>
          </Button>

          {isDirty && (
            <Button
              onClick={handleReset}
              disabled={saving}
              variant="outline"
              title="Reset changes to loaded configuration"
              className="h-8 px-2.5 border-border bg-background hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <RotateCcw size={13} />
            </Button>
          )}
        </div>

        {saveStatus && (
          <div
            className={`p-2 rounded-0 text-[11px] leading-tight border flex items-start gap-1.5 ${
              saveStatus.ok
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                : "bg-rose-500/10 border-rose-500/30 text-rose-600 dark:text-rose-400"
            }`}
          >
            <AlertCircle size={13} className="shrink-0 mt-0.5" />
            <span>{saveStatus.message}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default Sidebar;

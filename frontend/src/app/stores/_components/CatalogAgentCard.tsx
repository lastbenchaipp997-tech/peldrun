// frontend/src/app/stores/_components/CatalogAgentCard.tsx
"use client";

import React from "react";
import { Bot, Check, Download, Eye, Loader2, Shield, Tag } from "lucide-react";
import type { AgentCatalogItem, AgentCatalogInstallState } from "../_types/store";

export interface CatalogAgentCardProps {
  item: AgentCatalogItem;
  installState: AgentCatalogInstallState;
  onInstall: () => void;
  onOpenDetails: () => void;
  onOpenInstalled?: () => void;
  isInstalling?: boolean;
}

/**
 * Renders the agent's icon, supporting both inline SVG and Lucide icon names.
 * Mirrors the pattern from CatalogSkillCard for visual consistency.
 */
function CatalogAgentIcon({ item }: { item: AgentCatalogItem }) {
  const iconValue = item.icon;
  const iconType = item.icon_type ?? "name";

  // Case 1: Inline SVG
  if (iconValue && iconType === "svg") {
    return (
      <div
        className="flex h-12 w-12 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/10 to-purple-500/10"
        dangerouslySetInnerHTML={{ __html: iconValue }}
      />
    );
  }

  // Case 2: Lucide icon name (or fallback)
  const iconName = iconValue || "Bot";
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/10 to-purple-500/10">
      <Bot className="h-6 w-6 text-blue-600" />
    </div>
  );
}

/**
 * A single catalog agent card, mirroring the visual pattern of
 * CatalogSkillCard and ProviderCatalogCard for store consistency.
 */
export function CatalogAgentCard({
  item,
  installState,
  onInstall,
  onOpenDetails,
  onOpenInstalled,
  isInstalling = false,
}: CatalogAgentCardProps) {
  const displayName = item.display_name || item.name || item.id;
  const isInstalled = installState.isInstalled;
  const hasUpdate = isInstalled && item.version !== installState.installedVersion;
  const isDisabled = !item.installable || isInstalling;

  // Primary action button label and handler
  const getPrimaryAction = () => {
    if (!item.installable) {
      return { label: "Preview", icon: Eye, onClick: onOpenDetails, disabled: false };
    }
    if (isInstalled && !hasUpdate) {
      return {
        label: "Installed",
        icon: Check,
        onClick: onOpenInstalled || onOpenDetails,
        disabled: false,
      };
    }
    if (hasUpdate) {
      return { label: "Update", icon: Download, onClick: onInstall, disabled: isDisabled };
    }
    return { label: "Install", icon: Download, onClick: onInstall, disabled: isDisabled };
  };

  const primaryAction = getPrimaryAction();

  return (
    <div className="group relative flex flex-col rounded-xl border border-border bg-card p-4 transition-all hover:border-border/80 hover:shadow-md">
      {/* Header: Icon + Name + Version */}
      <div className="mb-3 flex items-start gap-3">
        <CatalogAgentIcon item={item} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">{displayName}</h3>
          <p className="text-xs text-muted-foreground">v{item.version}</p>
        </div>
        {/* Trust badge */}
        {item.trust === "verified" && (
          <div className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            <Shield className="h-3 w-3" />
            Verified
          </div>
        )}
      </div>

      {/* Description */}
      <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
        {item.description || "No description available."}
      </p>

      {/* Tags */}
      {item.tags && item.tags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {item.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              <Tag className="h-2.5 w-2.5" />
              {tag}
            </span>
          ))}
          {item.tags.length > 3 && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              +{item.tags.length - 3}
            </span>
          )}
        </div>
      )}

      {/* Install warnings */}
      {item.install_warnings && item.install_warnings.length > 0 && (
        <div className="mb-3 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <p className="font-medium">⚠️ Note:</p>
          <p className="mt-0.5">{item.install_warnings[0]}</p>
        </div>
      )}

      {/* Spacer to push actions to bottom */}
      <div className="flex-1" />

      {/* Action buttons */}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenDetails}
          className="flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Eye className="h-3.5 w-3.5" />
          Details
        </button>
        <button
          type="button"
          onClick={primaryAction.onClick}
          disabled={primaryAction.disabled}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isInstalling ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Installing…
            </>
          ) : (
            <>
              <primaryAction.icon className="h-3.5 w-3.5" />
              {primaryAction.label}
            </>
          )}
        </button>
      </div>

      {/* Install state indicator */}
      {isInstalled && (
        <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          <Check className="h-3 w-3 text-emerald-600" />
          <span>
            Installed: v{installState.installedVersion}
            {hasUpdate && ` (Update to v${item.version} available)`}
          </span>
        </div>
      )}

      {/* Installability reason (when not installable) */}
      {!item.installable && item.installability_reason && (
        <p className="mt-2 text-xs italic text-muted-foreground">
          {item.installability_reason}
        </p>
      )}
    </div>
  );
}

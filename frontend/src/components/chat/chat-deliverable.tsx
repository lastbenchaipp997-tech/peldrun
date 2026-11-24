//frontend\src\components\chat\chat-deliverable.tsx

"use client";

import React from "react";
import { FileText, ExternalLink, Activity, Check, Copy, AlertCircle, RotateCcw, PlayCircle } from "lucide-react";
import { useAppStorage } from "@/hooks/use-app-storage";
import { useProviderBadge } from "@/lib/providerBadge";
import { ProviderModelBadge } from "./chat-thread/ProviderModelBadge";
import { resolveFileCategory } from "./chat-thread/utils";
import { ChatReasoningPanel } from "./chat-thread/ChatReasoningPanel";
import { UsageBadgeGroup } from "@/components/chat/UsageBadges";
import { MarkdownRenderer } from "@/components/chat/markdown-renderer";
import type { TokenUsageInfo, TurnUsage } from "@/lib/types";

interface ChatDeliverableProps {
  finalResult: string;
  chatId?: string;
  /**
   * When provided, media preview URLs (img/video thumbnails) resolve
   * against the project workspace instead of the chat session folder.
   * The agent writes deliverables into the project workspace, so the
   * chat-scoped /api/chats/{id}/raw route cannot see them.
   */
  projectId?: string | null;
  status?: "completed" | "failed" | "stopped" | "paused";
  turnIndex?: number;
  isTurnRawTrace?: boolean;
  lastThoughtContent?: string;
  producedFiles?: { name: string; path: string; action?: string; status?: string }[];
  onSelectFile: (fileName: string) => void;
  copiedSection: string | null;
  onCopy: (text: string, identifier: string) => void;
  execMode?: "agent" | "chat";
  showRawTrace: boolean;
  setShowRawTrace: (show: boolean) => void;
  modelName?: string;
  /**
   * Display name of the provider that produced this deliverable.
   *
   * Preferred over reading `useAppStorage("active_provider")`
   * internally because:
   *   * Historical turns need their OWN provider snapshot
   *     (`turn.provider`), not whatever the user has selected NOW.
   *   * Live turns (rendered by ChatThread with `hideHeader={true}`)
   *     do not show the header at all, so the field is unused there
   *     — but keeping it optional makes the component safe for any
   *     future call site.
   *
   * When `undefined`, the component falls back to the currently-active
   * provider (legacy behavior, preserved for backward compatibility).
   */
  providerName?: string;
  timestamp?: string;
  /**
   * Full per-turn usage snapshot.
   *
   * The preferred way to feed this component with the complete
   * accounting matrix (tokens + cache hits + reasoning tokens +
   * cost + latency + throughput + provider). Callers that hold a
   * `TurnUsage` object should pass it here rather than re-packing
   * its individual fields — `UsageBadgeGroup` resolves every
   * sub-field internally.
   *
   * HistoricalTurn passes `turn={turn.usage}` (the ChatTurn's
   * TurnUsage snapshot); the live turn in ChatThread uses the flat
   * `tokensUsed` / `costUsd` / `latencyMs` fallbacks because it
   * does not yet have a fully-populated TurnUsage object.
   */
  turn?: Partial<TurnUsage> | null;
  /**
   * Inner TokenUsageInfo, when the caller only has the raw token
   * matrix (no cost/latency/provenance wrapper).
   *
   * Mutually exclusive with `turn` in practice; both are forwarded
   * to `UsageBadgeGroup` and its resolution chain prefers whichever
   * source supplies each field first. Kept for callers that
   * cannot build a full TurnUsage object.
   */
  usage?: TokenUsageInfo | null;
  tokensUsed?: { input?: number; output?: number; total?: number };
  costUsd?: number | null;
  latencyMs?: number | null;
  tokensPerSecond?: number | null;
  /**
   * Connection base URL that produced this turn.
   *
   * Used only by the `checkIsLocalProvider` heuristic so local
   * runtimes (LM Studio, Ollama, llama.cpp) render as
   * "Free (Local)" instead of "$0.00". Optional; when omitted,
   * detection falls back to the provider name alone.
   */
  baseUrl?: string | null;
  onRegenerate?: (turnIndex?: number) => void;
  hideHeader?: boolean;
  /**
   * Optional reasoning text rendered BETWEEN the identity header and
   * the primary response.
   *
   * Used by HistoricalTurn to place the Reasoning panel in the same
   * visual position as the live turn:
   *
   *   ChatThread (live):   Badge → Reasoning → Deliverable
   *   HistoricalTurn:      Deliverable { Header → Reasoning → Content }
   *
   * When undefined, nothing is rendered. Live turns pass this prop
   * as undefined because ChatThread already renders the panel
   * externally (before the deliverable).
   */
  reasoningContent?: string;
}

export function ChatDeliverable({
  finalResult,
  chatId,
  projectId,
  status = "completed",
  turnIndex,
  isTurnRawTrace = false,
  lastThoughtContent,
  producedFiles = [],
  onSelectFile,
  copiedSection,
  onCopy,
  execMode = "agent",
  showRawTrace,
  setShowRawTrace,
  modelName = "Assistant",
  providerName,
  timestamp,
  turn,
  usage,
  tokensUsed,
  costUsd,
  latencyMs,
  tokensPerSecond,
  baseUrl,
  onRegenerate,
  hideHeader = false,
  reasoningContent,
}: ChatDeliverableProps) {
  const copyId = typeof turnIndex === "number" ? `turn-res-${turnIndex}` : "final-result";

  // Resolve provider name + badge icon for THIS deliverable.
  //
  // Priority:
  //   1. `providerName` prop — the turn's own snapshot. Set by
  //      HistoricalTurn using `turn.provider ?? activeProvider`,
  //      which is the provider that ACTUALLY produced the turn.
  //   2. `useAppStorage("active_provider")` — the currently-active
  //      provider. Used as a last-resort fallback for call sites
  //      that do not (yet) pass the prop, preserving backward
  //      compatibility with any external consumer.
  //
  // The badge is resolved from whichever of the two wins, so the
  // icon and the label always refer to the SAME provider.
  const [activeProviderFallback] = useAppStorage("active_provider");
  const resolvedProviderName = providerName ?? activeProviderFallback;
  const providerBadge = useProviderBadge(resolvedProviderName);

  // Hide dot-prefixed paths (`.git/…`, `.peldrun/…`, `.env`,
  // `.gitignore`, …) from the user-facing deliverables list.
  // These paths are implementation details of the workspace — they
  // are not what the agent "produced" for the user, and they pollute
  // the deliverable card with dozens of internal Git files (hooks,
  // objects, refs, …) that bury the actual deliverables.
  //
  // The workspace panel (Files tab) still shows them in full, so the
  // user can inspect the Git internals when needed.
  //
  // The check splits on both POSIX and Windows separators so that
  // paths from either side of the stack are treated uniformly.
  const visibleProducedFiles = (producedFiles || []).filter((f) => {
    const raw = f.path || f.name || "";
    if (!raw) return false;
    const segments = raw.split(/[/\\]/);
    return !segments.some((segment) => segment.startsWith("."));
  });

  const hasFiles = visibleProducedFiles.length > 0;

  let displayContent = finalResult;
  if (isTurnRawTrace) {
    if (lastThoughtContent && lastThoughtContent.trim()) {
      displayContent = lastThoughtContent;
    } else if (hasFiles) {
      displayContent = "Task deliverables and files have been generated successfully in your workspace.";
    } else {
      displayContent = "Task completed successfully.";
    }
  }

  // Telemetry presence check.
  //
  // A turn may carry usage without a `tokensUsed` aggregate — for
  // example a provider that returns only cache-hit counters, a
  // local runtime that reports latency without token counts, or a
  // proxied endpoint that emits `costUsd` alone. Gating on
  // `tokensUsed.total` alone would silently drop all of those.
  //
  // The union check below mirrors the empty-state guard inside
  // `UsageBadgeGroup` (which returns null only when tokens, cost,
  // and latency are ALL empty), so the trigger button appears
  // exactly when the expanded panel would have something to show.
  const hasUsage = Boolean(
    (tokensUsed && tokensUsed.total && tokensUsed.total > 0) ||
      (usage &&
        ((usage.input_tokens ?? 0) > 0 ||
          (usage.output_tokens ?? 0) > 0 ||
          (usage.total_tokens ?? 0) > 0 ||
          (usage.cached_input_tokens ?? 0) > 0 ||
          (usage.reasoning_output_tokens ?? 0) > 0)) ||
      (turn &&
        ((turn.usage?.input_tokens ?? 0) > 0 ||
          (turn.usage?.output_tokens ?? 0) > 0 ||
          (turn.usage?.total_tokens ?? 0) > 0 ||
          (turn.usage?.cached_input_tokens ?? 0) > 0 ||
          (turn.usage?.reasoning_output_tokens ?? 0) > 0 ||
          (turn.cost_usd !== null && turn.cost_usd !== undefined) ||
          (turn.latency_ms !== null &&
            turn.latency_ms !== undefined &&
            turn.latency_ms > 0))) ||
      (costUsd !== null && costUsd !== undefined) ||
      (latencyMs !== null && latencyMs !== undefined && latencyMs > 0)
  );

  return (
    <div className="space-y-3 font-sans group/msg">
      {/* 1. Assistant Identity Header (conditionally hidden based on prop) */}
      {!hideHeader && (
        <div className="flex items-center justify-between text-xs text-muted-foreground pt-1">
          <ProviderModelBadge
            providerName={resolvedProviderName}
            modelName={modelName}
            providerBadge={providerBadge}
            execMode={execMode}
            timestamp={timestamp}
          />
        </div>
      )}

      {/* 1b. Reasoning panel — rendered BELOW the identity header
          and ABOVE the primary response.

          This matches the visual order used by ChatThread for the
          live turn (Badge → Reasoning → Deliverable). Without this
          placement, HistoricalTurn would render the panel ABOVE
          the header, which looked broken.

          The `!hideHeader` guard is defensive: when the header is
          suppressed (i.e., ChatThread's live call), the caller is
          expected to render the panel itself before this component. */}
      {!hideHeader && reasoningContent && reasoningContent.trim() !== "" && (
        <ChatReasoningPanel
          thoughtContent={reasoningContent}
          isRunning={false}
        />
      )}

      {/* 2. Primary Response.
          On failure/stop, this block is intentionally hidden: the
          red alert box below (section 4) renders the same message
          via MarkdownRenderer with the correct destructive styling.
          Showing both would duplicate the message — once at the top
          (with normal prose colors) and once in the alert box
          (with destructive colors). The duplicate was confusing
          users because the top occurrence rendered `### ⚠️ ...`
          literally when the error text itself started with a
          markdown header that the outer box wasn't designed to
          wrap in prose styling. */}
      {status !== "failed" && status !== "stopped" && (
        <div className="p-4 rounded-md bg-card/40 text-foreground text-sm leading-relaxed">
          <MarkdownRenderer content={displayContent} />
        </div>
      )}

      {/* 3. Diagnostic Trace Toggle */}
      {isTurnRawTrace && (
        <div className="border border-border/60 rounded-lg overflow-hidden bg-background/40">
          <button
            type="button"
            onClick={() => setShowRawTrace(!showRawTrace)}
            className="w-full flex items-center justify-between px-3.5 py-1.5 text-muted-foreground hover:text-foreground text-[11px] font-mono cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              <Activity size={13} className="shrink-0" />
              <span>Execution Trace & Observations</span>
            </span>
            <span>{showRawTrace ? "Hide diagnostic trace" : "View diagnostic trace"}</span>
          </button>
          {showRawTrace && (
            <div className="p-2.5 border-t border-border/40 font-mono text-[11px] text-muted-foreground bg-muted/30 whitespace-pre-wrap max-h-48 overflow-y-auto">
              {finalResult}
            </div>
          )}
        </div>
      )}

      {/* 4. Adaptive Deliverable Box: Error or Stop Alert.
          The message is rendered through MarkdownRenderer so the
          structured error cards produced by the backend's
          `format_smart_error` (### heading, > hint, ``` code block,
          **bold**) render with proper formatting instead of showing
          raw `### ⚠️ ...` and `> 💡 **Hint:**` syntax.
          The prose classes inside the wrapper neutralize any
          prose-inheritance conflicts with the destructive color
          palette. */}
      {(status === "failed" || status === "stopped") && (
        <div className="p-3.5 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-xs flex items-start gap-2.5">
          <AlertCircle size={15} className="shrink-0 mt-0.5" />
          <div className="space-y-1 flex-1 min-w-0">
            <span className="font-semibold block">
              {status === "stopped" ? "Execution Stopped by Operator" : "Execution Terminated with Error"}
            </span>
            <div className="text-[11px] leading-relaxed prose prose-sm max-w-none prose-headings:text-destructive prose-headings:font-semibold prose-headings:text-sm prose-headings:mt-0 prose-headings:mb-1 prose-p:text-destructive prose-p:opacity-90 prose-p:text-[11px] prose-strong:text-destructive prose-blockquote:text-destructive prose-blockquote:border-destructive/40 prose-blockquote:text-[11px] prose-blockquote:opacity-90 prose-blockquote:my-1 prose-blockquote:py-1 prose-code:text-destructive prose-code:bg-destructive/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[10px] prose-pre:bg-destructive/5 prose-pre:border prose-pre:border-destructive/20 prose-pre:text-destructive prose-pre:text-[10px] prose-pre:my-1 prose-pre:overflow-x-auto">
              <MarkdownRenderer
                content={
                  finalResult ||
                  (status === "stopped"
                    ? "Task was stopped by operator."
                    : "Execution was aborted or encountered an error.")
                }
              />
            </div>
          </div>
        </div>
      )}

      {/* 5. Adaptive Deliverable Box: Generated Files */}
      {execMode === "agent" && status === "completed" && hasFiles && (
        <div className="p-3.5 rounded-md bg-emerald-500/5  text-xs space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-emerald-500 font-semibold tracking-wide text-xs">
              TASK DELIVERABLES & OUTPUT FILES ({visibleProducedFiles.length})
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {visibleProducedFiles.map((f, idx) => {
              const isModified = f.action === "modified" || f.status === "modified";
              const targetPath = f.path || f.name;

              // Determine preview capability
              const info = resolveFileCategory(targetPath);
          // Project mode: serve media from the project workspace via the
          // path-scoped raw route (works for internal AND external
          // workspaces). Chat mode keeps the legacy per-chat raw route.
          // Per-segment encoding is preserved so spaces and special
          // characters in folder names resolve correctly.
          const fileUrl = projectId
            ? `/api/files/raw-project/${encodeURIComponent(projectId)}/${targetPath
                .split("/")
                .map(encodeURIComponent)
                .join("/")}`
            : chatId
              ? `/api/chats/${chatId}/raw/${targetPath
                  .split("/")
                  .map(encodeURIComponent)
                  .join("/")}`
              : null;

              // 1. Image Preview
              if (info.isImage && fileUrl) {
                return (
                  <button
                    key={`${targetPath}-${idx}`}
                    type="button"
                    onClick={() => onSelectFile(targetPath)}
                    className="relative w-24 h-24 sm:w-28 sm:h-28 rounded-md overflow-hidden bg-muted/40 border border-border shadow-sm hover:border-primary/50 hover:shadow-md transition-all group cursor-pointer flex-shrink-0"
                    title={`Preview ${targetPath} in Workspace`}
                  >
                    <img
                      src={fileUrl}
                      alt={targetPath}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-1.5">
                      <span className="text-[10px] text-white truncate max-w-full font-mono">
                        {targetPath.split("/").pop()}
                      </span>
                    </div>
                    {isModified && (
                      <span className="absolute top-1 right-1 text-[9px] px-1 py-0.5 rounded bg-amber-500 text-white font-mono font-semibold shadow-sm">
                        Mod
                      </span>
                    )}
                    {!isModified && (
                      <span className="absolute top-1 right-1 text-[9px] px-1 py-0.5 rounded bg-emerald-500 text-white font-mono font-semibold shadow-sm">
                        New
                      </span>
                    )}
                  </button>
                );
              }

              // 2. Video/Audio Preview
              if (info.isAudioVideo && fileUrl) {
                return (
                  <button
                    key={`${targetPath}-${idx}`}
                    type="button"
                    onClick={() => onSelectFile(targetPath)}
                    className="relative w-24 h-24 sm:w-28 sm:h-28 rounded-md overflow-hidden bg-black flex items-center justify-center border border-border shadow-sm hover:border-primary/50 hover:shadow-md transition-all group cursor-pointer flex-shrink-0"
                    title={`Preview ${targetPath} in Workspace`}
                  >
                    <video
                      src={fileUrl}
                      className="w-full h-full object-cover opacity-80"
                      muted
                      playsInline
                      preload="metadata"
                    />
                    <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/40 transition-colors">
                      <PlayCircle className="text-white w-8 h-8 opacity-80 drop-shadow-md" />
                    </div>
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-1.5 pointer-events-none">
                      <span className="text-[10px] text-white truncate max-w-full font-mono">
                        {targetPath.split("/").pop()}
                      </span>
                    </div>
                  </button>
                );
              }

              // 3. Fallback: Generic File Icon (PDFs, code, data, etc.)
              return (
                <button
                  key={`${targetPath}-${idx}`}
                  type="button"
                  onClick={() => onSelectFile(targetPath)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-card hover:bg-muted text-foreground border border-card text-xs cursor-pointer shadow-sm hover:shadow-xl transition-all"
                  title={`Preview ${targetPath} in Workspace`}
                >
                  <FileText size={13} className="text-primary shrink-0" />
                  <span className="font-medium font-mono truncate max-w-[200px]">{targetPath}</span>
                  {isModified ? (
                    <span className="text-[9px] px-1 py-0.2 rounded bg-amber-500/20 text-amber-600 dark:text-amber-400 font-mono font-semibold">
                      Modified
                    </span>
                  ) : (
                    <span className="text-[9px] px-1 py-0.2 rounded bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 font-mono font-semibold">
                      New
                    </span>
                  )}
                  <ExternalLink size={10} className="opacity-60 shrink-0" />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 6. Bottom Action Toolbar */}
      <div className="flex items-center justify-between gap-2 pt-2 text-xs opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity duration-200">
        <div className="flex items-center">
          {hasUsage && (
            <UsageBadgeGroup
              // Full per-turn snapshot (preferred). Carries the token
              // matrix, prompt-cache hits, reasoning tokens, cost,
              // latency, throughput, and provider snapshot in a
              // single object — the resolution chain in
              // UsageBadgeGroup picks whichever fields are present.
              turn={turn}
              // Raw token matrix fallback for callers without a
              // TurnUsage wrapper.
              usage={usage}
              // Flat props from ChatThread's live turn — the source
              // that feeds the current in-progress response.
              tokensUsed={tokensUsed}
              // Pass `costUsd` as-is (may be null). CostBadge treats
              // null as "unknown" and hides the badge; a `?? 0`
              // coercion here would render unknown as "$0.00" which
              // is actively misleading.
              costUsd={costUsd}
              latencyMs={latencyMs}
              tokensPerSecond={tokensPerSecond}
              // Feed the resolved provider name + base URL so the
              // `checkIsLocalProvider` heuristic can classify local
              // runtimes correctly ("Free (Local)" vs "$0.00").
              provider={resolvedProviderName}
              baseUrl={baseUrl}
              model={modelName}
              variant="card"
            />
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {onRegenerate && (
            <button
              type="button"
              onClick={() => onRegenerate(turnIndex)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-black/50 hover:text-foreground cursor-pointer transition-all text-[11px]"
              title="Regenerate Response"
            >
              <RotateCcw size={12} className="shrink-0" />

            </button>
          )}

          <button
            type="button"
            onClick={() => onCopy(displayContent, copyId)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-black/50 hover:text-foreground cursor-pointer transition-all text-[11px]"
            title="Copy Response"
          >
            {copiedSection === copyId ? (
              <>
                <Check size={12} className="text-emerald-500 shrink-0" />
                <span className="text-emerald-500 font-medium font-mono">Copied!</span>
              </>
            ) : (
              <>
                <Copy size={12} className="shrink-0" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ChatDeliverable;

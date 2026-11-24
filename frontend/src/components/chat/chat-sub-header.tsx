"use client";

import React from "react";
import Link from "next/link";
import { Plus, History, Square, PanelRightClose, PanelRightOpen, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EngineOption, EngineSelector } from "./engine-selector";
import { UsageBadgeGroup } from "@/components/chat/UsageBadges";
import type { ChatUsageSummary } from "@/lib/types";
import { ModeBadge } from "@/features/memory/components/ModeBadge";

import { ExtractFromChatButton } from '@/features/memory/components/ExtractFromChatButton';



 // app/layout.tsx أو TopBar.tsx

interface ChatSubHeaderProps {
  isFreshSession: boolean;
  submittedPrompt: string;
  activeChatId: string | null;
  activeJobId: string | null;
  historyTurnsCount: number;
  tokensUsed: { input: number; output: number; total: number };
  currentStepNum: number;
  maxSteps?: number;
  execMode: "agent" | "chat";
  selectedEngineId?: string;
  onSelectEngine?: (engine: EngineOption) => void;
  onNewSession: () => void;
  onStopTask: () => void;
  showRightPanel: boolean;
  onToggleRightPanel: () => void;
  /**
   * Whether the Source Control side panel is currently visible.
   *
   * Optional so that layouts which do not use the Source Control
   * side panel are not forced to thread this prop through. When
   * omitted, the Source Control button is not rendered.
   */
  showSourceControlPanel?: boolean;
  /**
   * Toggle handler for the Source Control side panel. Required
   * when `showSourceControlPanel` is provided; omitted otherwise.
   */
  onToggleSourceControlPanel?: () => void;

  // Canonical status union — mirrors SessionStatus in
  // docs/state-contracts.md §3. The previous narrower union
  // ("idle" | "running" | "ready" | "completed" | "error") could
  // not represent `cancelling`, `cancelled`, `paused`,
  // `waiting_for_input`, or `failed`, forcing callers to pass
  // values through `as any`. Keeping the union complete makes the
  // badge logic below exhaustive and lets ChatContainer drop those
  // casts in a future cleanup.
  status?:
    | "idle"
    | "pending"
    | "queued"
    | "starting"
    | "running"
    | "waiting_for_input"
    | "retrying"
    | "paused"
    | "cancelling"
    | "cancelled"
    | "completed"
    | "failed"
    | "interrupted"
    | "error"
    | "ready";
  sessionTitle?: string;
  stepCount?: number;

  // Optional telemetry overrides
  usageSummary?: ChatUsageSummary | null;
  activeProvider?: string | null;
  activeModel?: string | null;
  totalCostUsd?: number | null;
}

export function ChatSubHeader({
  isFreshSession,
  historyTurnsCount,
  tokensUsed,
  currentStepNum,
  maxSteps = 30,
  execMode,
  onNewSession,
  onStopTask,
  showRightPanel,
  onToggleRightPanel,
  showSourceControlPanel,
  onToggleSourceControlPanel,
  status = "idle",
  stepCount,
  usageSummary,
  activeProvider,
  activeModel,
  totalCostUsd,
  // Phase 3: forwarded to `<ExtractFromChatButton>` below. Optional
  // (nullable) because a fresh session has no active chat yet; the
  // button is not rendered in that case.
  activeChatId,
}: ChatSubHeaderProps) {
  // Safe aggregation: fallback gracefully to tokensUsed if usageSummary is absent
  // Note: `usageSummary` is forwarded directly to `UsageBadgeGroup`
  // (see render below). We intentionally do NOT synthesize a fallback
  // summary from `tokensUsed` because:
  //   1. `ChatUsageSummary.total_cost_usd` is strictly typed as
  //      `number`, so a `null` fallback would break the type.
  //   2. A synthesized summary would carry `0` for the cost, and
  //      `UsageBadgeGroup` would render a misleading "$0.00" when
  //      the real cost is simply unknown.
  // When `usageSummary` is absent, the badge group falls back to the
  // `tokensUsed` / `costUsd` props we pass alongside it.

  return (
    <div className="h-12 flex items-center justify-between px-5 bg-transparent backdrop-blur-sm shrink-0 font-sans">
      <div className="flex items-center gap-2.5">
        {isFreshSession ? (
          <EngineSelector />
        ) : (



          <button
            type="button"
            onClick={onNewSession}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 text-xs font-medium rounded-md border border-border bg-card hover:bg-muted text-foreground transition-all shadow-peldrun-xs cursor-pointer"
            title="Start a fresh autonomous session"
          >
            <Plus size={13} />
            <span>New Session</span>
          </button>




        )}

      </div>

      <div className="flex items-center gap-2.5">

        {/* Memory mode indicator -- tiny pill linking to the
            memory settings page. Renders a skeleton while the
            settings query is loading (see ModeBadge), so it
            never causes a layout shift after mount. Hidden on
            very narrow screens; the memory page itself always
            shows the mode in its own header. */}
        <Link
          href="/memory/settings"
          className="hidden sm:inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label="Memory settings"
          title="Memory settings"
        >
          <ModeBadge size="sm" />
        </Link>

        {/* Token & Telemetry Badges Cluster */}
        {/* Single Unified Header Badge */}
        {/* Passes the raw sources so `UsageBadgeGroup` can resolve
            each field independently:
              - `summary` carries `cached_input_tokens` and
                `reasoning_output_tokens` when the backend provides
                a full session aggregate.
              - `tokensUsed` is the flat aggregate fallback.
              - `costUsd` is passed as-is (may be null) so the
                CostBadge hides itself instead of rendering a fake
                "$0.00".
            `UsageBadgeGroup` internally returns `null` when none of
            tokens / cost / latency are present, so no additional
            guard is needed here. */}
        <UsageBadgeGroup
          tokensUsed={tokensUsed}
          summary={usageSummary}
          costUsd={totalCostUsd}
          provider={activeProvider}
          model={activeModel}
          variant="compact"
          showBreakdown={true}
        />


        {/* STEP COUNTER: Strict Isolation - Visible ONLY when execMode === 'agent' */}
        {execMode === "agent" && (status === "running" || currentStepNum > 0) && (
          <span className="text-xs font-mono text-foreground font-semibold px-2 py-0.5 bg-muted rounded-md border border-border/60 animate-in fade-in">
            Step {currentStepNum} / {maxSteps}
          </span>
        )}

        {historyTurnsCount > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono bg-muted border border-border text-muted-foreground">
            <History size={10} />
            <span>Turn {historyTurnsCount + 1}</span>
          </span>
        )}

        {/* ─── Status badge ────────────────────────────────────────
            One badge, chosen by the current status. Each status uses
            a distinct color so the operator can recognize the state
            at a glance:

              running             → amber, pulsing (active work)
              cancelling          → rose, pulsing (stop in flight)
              cancelled           → slate (user chose to stop)
              failed              → rose (error)
              completed           → emerald (success)
              paused              → blue (operator suspended)
              waiting_for_input   → violet (HITL or approval)
              retrying            → amber (transient retry)
              interrupted         → orange (server restart / crash)

            See docs/state-contracts.md §3.3 for terminal vs non-
            terminal classification. */}
        {(() => {
          switch (status) {
            case "running":
              return (
                <div className="hidden sm:flex items-center gap-1.5">
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-[11px] font-mono font-medium bg-amber-500/15 text-amber-500 border border-amber-500/30">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                    <span>RUNNING</span>
                  </span>
                  {typeof stepCount === "number" && (
                    <span className="text-[11px] font-mono text-muted-foreground px-1.5 py-0.5 rounded-sm bg-background border border-border">
                      Step {stepCount}
                    </span>
                  )}
                </div>
              );

            case "cancelling":
              return (
                <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-[11px] font-mono font-medium bg-rose-500/15 text-rose-500 border border-rose-500/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
                  <span>STOPPING…</span>
                </span>
              );

            case "cancelled":
              return (
                <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-[11px] font-mono font-medium bg-slate-500/15 text-slate-500 dark:text-slate-300 border border-slate-500/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                  <span>CANCELLED</span>
                </span>
              );

            case "failed":
              return (
                <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-[11px] font-mono font-medium bg-rose-500/15 text-rose-500 border border-rose-500/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                  <span>FAILED</span>
                </span>
              );

            case "completed":
              return (
                <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-[11px] font-mono font-medium bg-emerald-500/15 text-emerald-500 border border-emerald-500/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  <span>COMPLETED</span>
                </span>
              );

            case "paused":
              return (
                <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-[11px] font-mono font-medium bg-blue-500/15 text-blue-500 border border-blue-500/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                  <span>PAUSED</span>
                </span>
              );

            case "waiting_for_input":
              return (
                <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-[11px] font-mono font-medium bg-violet-500/15 text-violet-500 border border-violet-500/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" />
                  <span>AWAITING INPUT</span>
                </span>
              );

            case "retrying":
              return (
                <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-[11px] font-mono font-medium bg-amber-500/15 text-amber-500 border border-amber-500/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                  <span>RETRYING</span>
                </span>
              );

            case "interrupted":
              return (
                <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-[11px] font-mono font-medium bg-orange-500/15 text-orange-500 border border-orange-500/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-orange-500" />
                  <span>INTERRUPTED</span>
                </span>
              );

            default:
              return null;
          }
        })()}


        {/* Extract-from-chat button -- only when there is an
            ACTIVE chat. In a fresh session there is nothing to
            extract yet, and the backend would return
            `job: null` (no turns). Skipping the render also
            avoids a flash of a disabled button during the brief
            window between the new-session click and the first
            turn's persistence. */}
        {activeChatId && (
          <ExtractFromChatButton
            chatId={activeChatId}
            onQueued={(job) => console.log('queued:', job.job_id)}
            onNoop={(msg) => console.log('noop:', msg)}
          />
        )}

        {/* Stop button — visible during `running` OR `paused`, hidden
            during `cancelling` to prevent double-click. The rose
            theme (vs destructive) makes it visually consistent with
            the "STOPPING…" badge above. */}
        {(status === "running" || status === "paused") && (
          <Button
            variant="destructive"
            size="sm"
            onClick={onStopTask}
            className="active:bg-red-800 bg-red-600 hover:bg-red-700 text-white h-7 px-2.5 text-xs font-sans rounded-md cursor-pointer shadow-sm transition-colors"
          >
            <Square size={11} className="fill-current mr-1" />
            <span>Stop</span>
          </Button>
        )}

        <button
          type="button"
          onClick={onToggleRightPanel}
          className="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-all cursor-pointer"
          title={showRightPanel ? "Hide Right Workspace Panel" : "Show Right Workspace Panel"}
        >
          {showRightPanel ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>

        {/* Source Control side panel toggle.
            Rendered only when the caller opts in via
            `showSourceControlPanel`, so existing layouts that do not
            use the Source Control panel keep their current header
            width without change. */}
        {onToggleSourceControlPanel && (
          <button
            type="button"
            onClick={onToggleSourceControlPanel}
            className={`p-1.5 rounded-md transition-all cursor-pointer ${
              showSourceControlPanel
                ? "text-primary bg-primary/10"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
            title={
              showSourceControlPanel
                ? "Hide Source Control panel"
                : "Show Source Control panel"
            }
          >
            <GitBranch size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

export default ChatSubHeader;

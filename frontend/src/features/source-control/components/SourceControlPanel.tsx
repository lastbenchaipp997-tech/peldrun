// frontend/src/features/source-control/components/SourceControlPanel.tsx

import React, { useEffect, useState } from "react";
import { sourceControlClient } from "../api/source-control-client";
import { useSourceControlStore } from "../state/source-control-store";
import { useOperation } from "../hooks/useOperation";
import { useManualModeStore } from "../state/manual-mode-store";
import { ApprovalHeader } from "./ApprovalHeader";
import { FileChangeList } from "./FileChangeList";
import { DiffViewer } from "./DiffViewer";
import { CheckResults } from "./CheckResults";
import { ApprovalDialog } from "./ApprovalDialog";
import { OperationTimeline } from "./OperationTimeline";
import { ManualModePanel } from "./manual/ManualModePanel";
import { GitBrowserPanel } from "./git/GitBrowserPanel";
import { AuthReconnectBanner } from "./AuthReconnectBanner";
import { GitPullRequest, AlertCircle, Loader2 } from "lucide-react";
export interface SourceControlPanelProps {
  chatId?: string;
  /**
   * Mode that the panel should open in by default.
   *
   * Set to `"browse"` when the panel is used as a standalone side
   * panel (the user opened it specifically to look at the repo),
   * and leave unset (defaults to `"agent"`) when it is used inside
   * `WorkspacePanel`.
   */
  defaultMode?: PanelMode;
}

type PanelMode = "agent" | "manual" | "browse";

/**
 * Source Control panel with two modes: Agent and Manual.
 *
 * DESIGN DECISION — both panels are kept MOUNTED at all times:
 *
 *   The Agent panel owns a live `useOperation` polling loop. If we
 *   conditionally rendered only the active mode, switching to
 *   Manual Mode would unmount Agent Mode, which:
 *
 *     - Cancels the polling loop (operation updates stop arriving).
 *     - Resets local view state (active tab, scroll position).
 *     - Forces a full re-fetch when switching back.
 *
 *   By keeping both mounted and hiding the inactive one with the
 *   `hidden` class, switching modes is instant, cheap, and does
 *   not disturb either workflow's state.
 *
 * DESIGN DECISION — Manual Mode state is NOT reset on toggle:
 *
 *   The manual store preserves (chatId, step, workspaceId, diff,
 *   approvalId) across toggles. The user resumes exactly where they
 *   left off when they switch back. Files on disk are never touched
 *   by a mode switch.
 */
export function SourceControlPanel({
  chatId: propChatId,
  defaultMode = "agent",
}: SourceControlPanelProps = {}) {
  const [mode, setMode] = useState<PanelMode>(defaultMode);

  // `reloadKey` is bumped every time the user completes an inline
  // OAuth re-connect via `<AuthReconnectBanner />`. Mounting the
  // active panels with `key={reloadKey}` forces a full remount, which
  // in turn re-runs every `useEffect` that fetches data. That is the
  // simplest way to guarantee a clean state after a token rotation:
  // every stale request is abandoned and every view re-fetches with
  // the fresh token.
  const [reloadKey, setReloadKey] = useState(0);

  // Resolve chat id: prefer the prop; fall back to URL.
  const resolvedChatId = propChatId ?? deriveChatIdFromUrl();

  // Listen for the "auth reconnected" event fired by the banner and
  // bump the reload key so all live panels remount.
  useEffect(() => {
    const onReconnected = () => setReloadKey((k) => k + 1);
    window.addEventListener("peldrun:auth-reconnected", onReconnected);
    return () => {
      window.removeEventListener(
        "peldrun:auth-reconnected",
        onReconnected
      );
    };
  }, []);

  // Activate the manual store only when the user first switches to
  // Manual Mode. Subsequent toggles do NOT re-activate, so the
  // workflow state survives.
  useEffect(() => {
    if (mode !== "manual") return;
    if (!resolvedChatId) return;

    const manual = useManualModeStore.getState();
    if (!manual.isActive || manual.chatId !== resolvedChatId) {
      manual.activate(resolvedChatId);

      // Resolve the list of workspaces visible to this chat.
      // Three outcomes drive the next step:
      //
      //   - 0 workspaces → stay on "select-repo"; the
      //     `RepoSelectionStep` component in `ManualModePanel`
      //     detects the empty list and forces the clone flow.
      //
      //   - 1 workspace → auto-select it and jump straight to
      //     "editing". This preserves the historical single-
      //     workspace behaviour: a fresh chat that inherits a
      //     project with one repo goes straight to work.
      //
      //   - 2+ workspaces → stay on "select-repo"; the picker
      //     renders the list and lets the user choose. The
      //     "select-repo" step no longer means "clone"; it now
      //     means "pick from existing, or clone new".
      void (async () => {
        try {
          const workspaces =
            await sourceControlClient.listWorkspacesByChat(
              resolvedChatId
            );
          useSourceControlStore
            .getState()
            .setAvailableWorkspaces(workspaces);

          if (workspaces.length === 1) {
            // Single workspace: auto-select, exactly like the
            // old `getWorkspaceByChat` flow did.
            const ws = workspaces[0];
            useSourceControlStore
              .getState()
              .setActiveWorkspace(ws.workspace_id);
            useManualModeStore.getState().setWorkspace(ws);
          }
          // For 0 or 2+ workspaces, `RepoSelectionStep` renders
          // the appropriate UI on the "select-repo" step that
          // `activate()` already set.
        } catch (err) {
          console.warn(
            "[Manual Mode] listWorkspacesByChat failed:",
            err
          );
          // Fall through: `RepoSelectionStep` will show its own
          // error state when its selector fails to load.
        }
      })();
    }
  }, [mode, resolvedChatId]);

  return (
    <div className="flex flex-col h-full bg-background border-l border-border">
      {/* Auth banner — sits ABOVE the tabs so it is visible in
          Agent, Manual, and Browse modes alike. */}
      <AuthReconnectBanner />

      {/* Mode Toggle */}
      <div className="flex items-center px-4 py-2 border-b border-border bg-custom shrink-0">
        <div className="flex rounded-md bg-muted p-0.5" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "agent"}
            onClick={() => setMode("agent")}
            className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
              mode === "agent"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Agent Mode
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "manual"}
            onClick={() => setMode("manual")}
            className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
              mode === "manual"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Manual Mode
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "browse"}
            onClick={() => setMode("browse")}
            className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
              mode === "browse"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Browse
          </button>
        </div>
      </div>

      {/*
        Both panels stay mounted. The `hidden` Tailwind utility sets
        `display: none`, which pauses paint but keeps React state
        and effects intact.
      */}
      <div className="flex-1 overflow-hidden relative">
        <div className={mode === "agent" ? "h-full" : "hidden"}>
          <AgentModePanel key={`agent-${reloadKey}`} />
        </div>
        <div className={mode === "manual" ? "h-full" : "hidden"}>
          {/* Added reloadKey so the panel resets and re-fetches upon reconnection */}
          <ManualModePanel key={`manual-${reloadKey}`} />
        </div>
        <div className={mode === "browse" ? "h-full" : "hidden"}>
          <BrowsePanel key={`browse-${reloadKey}`} chatId={resolvedChatId} />
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Browse panel (Repository Browser / History / Branches)
// ----------------------------------------------------------------------

type BrowseResolveState =
  | { status: "loading" }
  | {
      status: "ready";
      workspaceId: string;
      repositoryId: string;
      provider: string;
      currentBranch: string;
    }
  | { status: "empty"; reason: "no-chat" | "no-workspace" };

/**
 * Mounted only when the user selects the Browse tab.
 *
 * The wrapper resolves the workspace from two sources, in priority
 * order:
 *
 *   1. The active source-control operation (set when the user
 *      clicked "Open Review & Approve" in Agent Mode).
 *   2. The chat's own workspace, resolved via `getWorkspaceByChat`.
 *      This is the path Manual Mode uses, and it is what allows
 *      Browse to work without going through the Agent flow.
 *
 * While resolving, a loading spinner is shown instead of the
 * "No workspace" placeholder. This avoids the confusing flash of
 * "empty" content that the previous implementation produced on
 * every mount, and it also prevents a race where the user clicks
 * Browse before the operation state has settled.
 *
 * DESIGN — why call `getWorkspace` even when activeOperation exists:
 *   `activeOperation.target_branch` is the operation's TARGET
 *   branch, not necessarily the workspace's CURRENT branch. The
 *   two coincide for a push operation but can diverge for other
 *   kinds. Asking the workspace for its real `current_branch`
 *   guarantees BranchManager highlights the correct branch.
 */
function BrowsePanel({ chatId }: { chatId: string | null }) {
  const [state, setState] = useState<BrowseResolveState>({
    status: "loading",
  });
  const activeOperation = useSourceControlStore(
    (s) => s.activeOperation
  );
  // Subscribe to the store's workspace selection so the panel
  // reacts to a switch made through either:
  //   - the compact selector in `GitBrowserPanel`'s header, or
  //   - a Manual Mode workspace pick (which writes the same store
  //     field), or
  //   - any future caller that invokes `setActiveWorkspace`.
  const activeWorkspaceId = useSourceControlStore(
    (s) => s.activeWorkspaceId
  );
  const availableWorkspaces = useSourceControlStore(
    (s) => s.availableWorkspaces
  );
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      if (cancelled) return;
      setState({ status: "loading" });

      // Strategy 0: an explicit selection from the store. This is
      // the highest-priority signal because it reflects a user
      // action ("I want THIS repository"), while the other
      // strategies reflect automatic resolution.
      if (activeWorkspaceId) {
        const selected = availableWorkspaces.find(
          (w) => w.workspace_id === activeWorkspaceId
        );
        if (selected) {
          setState({
            status: "ready",
            workspaceId: selected.workspace_id,
            repositoryId: selected.repository_id,
            provider: "github",
            currentBranch: selected.current_branch || "main",
          });
          return;
        }
      }

      // Strategy 1: the active operation's workspace. Fires when
      // the user clicked "Open Review & Approve" from Agent Mode.
      if (activeOperation?.workspace_id) {
        // The operation's workspace might already be in the
        // available list; if so, reuse it and avoid a network
        // round-trip.
        const inList = availableWorkspaces.find(
          (w) => w.workspace_id === activeOperation.workspace_id
        );
        if (inList) {
          useSourceControlStore
            .getState()
            .setActiveWorkspace(inList.workspace_id);
          return; // The store update triggers a re-render and a
          // second pass through this effect that hits Strategy 0.
        }
        try {
          const ws = await sourceControlClient.getWorkspace(
            activeOperation.workspace_id
          );
          if (cancelled) return;
          useSourceControlStore
            .getState()
            .setActiveWorkspace(ws.workspace_id);
          setState({
            status: "ready",
            workspaceId: ws.workspace_id,
            repositoryId:
              ws.repository_id || activeOperation.repository_id || "",
            provider: activeOperation.provider || "github",
            currentBranch:
              ws.current_branch ||
              activeOperation.target_branch ||
              "main",
          });
          return;
        } catch (err) {
          console.warn(
            "[BrowsePanel] getWorkspace failed; falling back to chat lookup:",
            err
          );
        }
      }

      // Strategy 2: first available workspace from the store. If
      // the list is already populated (for example, by Manual Mode
      // or by a prior fetch), use the first entry so the user sees
      // content instead of an empty state.
      if (availableWorkspaces.length > 0) {
        const first = availableWorkspaces[0];
        useSourceControlStore
          .getState()
          .setActiveWorkspace(first.workspace_id);
        // The store update triggers a re-render and the effect
        // runs again; Strategy 0 picks up the selection.
        return;
      }

      // Strategy 3: fetch the list from the chat and use its
      // first entry. This is the cold-start path (first mount in
      // a fresh session) where nothing is cached yet.
      if (chatId) {
        try {
          const workspaces =
            await sourceControlClient.listWorkspacesByChat(chatId);
          if (cancelled) return;
          useSourceControlStore
            .getState()
            .setAvailableWorkspaces(workspaces);
          if (workspaces.length > 0) {
            const first = workspaces[0];
            useSourceControlStore
              .getState()
              .setActiveWorkspace(first.workspace_id);
            setState({
              status: "ready",
              workspaceId: first.workspace_id,
              repositoryId: first.repository_id,
              provider: "github",
              currentBranch: first.current_branch || "main",
            });
            return;
          }
        } catch (err) {
          console.warn(
            "[BrowsePanel] listWorkspacesByChat failed:",
            err
          );
        }
      }

      if (cancelled) return;
      setState({
        status: "empty",
        reason: chatId ? "no-workspace" : "no-chat",
      });
    }

    resolve();
    return () => {
      cancelled = true;
    };
  }, [
    chatId,
    activeOperation?.operation_id,
    activeWorkspaceId,
    availableWorkspaces,
    reloadKey,
  ]);

  if (state.status === "loading") {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
          <p className="text-xs">Loading workspace…</p>
        </div>
      </div>
    );
  }

  if (state.status === "empty") {
    return (
      <div className="flex items-center justify-center h-full p-8 text-center text-muted-foreground">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {state.reason === "no-chat"
              ? "No chat selected"
              : "No workspace found for this chat"}
          </h3>
          <p className="text-xs mt-2 max-w-sm leading-relaxed">
            {state.reason === "no-chat"
              ? "Open a chat that has a source-control workspace to browse its repository."
              : "Use Manual Mode to create a workspace, or ask the Agent to start a task that touches this repository."}
          </p>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="mt-3 text-xs px-3 py-1.5 rounded border border-border hover:bg-muted"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Show the compact in-header selector only when there are at
  // least two workspaces to choose from. A single-workspace chat
  // does not need a selector (there is nothing to pick), and the
  // empty case is already handled above.
  const showSelector = availableWorkspaces.length > 1;

  return (
    <GitBrowserPanel
      workspaceId={state.workspaceId}
      repositoryId={state.repositoryId}
      provider={state.provider}
      currentBranch={state.currentBranch}
      chatId={chatId}
      showWorkspaceSelector={showSelector}
      onWorkspaceSwitch={(ws) => {
        // The selector already wrote `activeWorkspaceId` to the
        // store; the effect above re-runs and re-renders with the
        // new workspace. We only bump `reloadKey` here as an
        // escape hatch for the rare case where the workspace id
        // did not change (same-id switch) but the user still
        // wants fresh data.
        useSourceControlStore
          .getState()
          .setActiveWorkspace(ws.workspace_id);
        setReloadKey((k) => k + 1);
      }}
    />
  );
}

function deriveChatIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;

  const pathMatch = window.location.pathname.match(
    /\/(?:chats?|c)\/([^/?#]+)/
  );
  if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]);

  const params = new URLSearchParams(window.location.search);
  return params.get("chat_id") ?? params.get("chat") ?? null;
}

// ----------------------------------------------------------------------
// Agent Mode panel (isolated from Manual Mode)
// ----------------------------------------------------------------------

function AgentModePanel() {
  const { activeOperationId } = useSourceControlStore();
  const [viewMode, setViewMode] = useState<"review" | "timeline">(
    "review"
  );

  const {
    operation,
    diff,
    isLoading,
    isActionLoading,
    approveAndPush,
    rejectOperation,
  } = useOperation(activeOperationId);

  const isStale =
    operation?.current_state === "stale_review_required" ||
    operation?.error_code === "REMOTE_STATE_CHANGED";

  if (!activeOperationId) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center text-muted-foreground">
        <GitPullRequest className="w-12 h-12 mb-4 text-muted-foreground/50" />
        <h3 className="text-sm font-semibold text-foreground">
          No Active Operation
        </h3>
        <p className="text-xs mt-2 max-w-sm leading-relaxed">
          When you ask the agent to modify code or create a pull request,
          the review interface will appear here.
        </p>
        <p className="text-[11px] mt-2 text-muted-foreground/70">
          Tip: click "Open Review &amp; Approve" in the chat to attach the
          latest operation.
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <svg
          className="animate-spin h-8 w-8 text-primary"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
            fill="none"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-4 py-2 border-b border-border bg-card/40 shrink-0">
        <div className="flex space-x-1">
          <button
            type="button"
            onClick={() => setViewMode("review")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              viewMode === "review"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            Diff &amp; Review
          </button>
          <button
            type="button"
            onClick={() => setViewMode("timeline")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              viewMode === "timeline"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            Logs / Timeline
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {viewMode === "timeline" ? (
          <OperationTimeline events={operation?.events || []} />
        ) : (
          <>
            {isStale && (
              <div className="flex items-start rounded-md bg-red-50 p-3 border border-red-200">
                <AlertCircle className="h-5 w-5 text-red-600 mr-2 flex-shrink-0" />
                <div>
                  <h3 className="text-sm font-medium text-red-800">
                    Remote State Changed
                  </h3>
                  <p className="text-xs text-red-700 mt-1">
                    The remote branch has moved since this review started.
                    You must re-review the latest changes.
                  </p>
                </div>
              </div>
            )}

            {operation && diff && (
              <ApprovalHeader
                operation={operation}
                diff={diff}
                isStale={isStale}
              />
            )}

            {diff && <FileChangeList files={diff.files} />}

            {diff && (
              <div className="rounded-md border border-border bg-card shadow-sm overflow-hidden">
                <div className="border-b border-border bg-muted/50 px-4 py-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    Code Changes
                  </h3>
                </div>
                <DiffViewer
                  diffText={diff.diff_sample}
                  isTruncated={diff.is_truncated}
                />
              </div>
            )}

            <CheckResults summary={null} isLoading={false} />
          </>
        )}
      </div>

      {viewMode === "review" &&
        (operation?.current_state === "review_required" || isStale) && (
          <div className="border-t border-border bg-card p-4 shrink-0">
            <ApprovalDialog
              operationType={operation.operation_type}
              targetBranch={operation.target_branch}
              isActionLoading={isActionLoading}
              isStale={isStale}
              onApprove={approveAndPush}
              onReject={rejectOperation}
            />
          </div>
        )}
    </div>
  );
}

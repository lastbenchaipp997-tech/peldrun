// frontend/src/features/source-control/components/WorkspaceSelector.tsx

/**
 * WorkspaceSelector
 *
 * Presents the repositories available to the current chat (or
 * project) and lets the user pick the one they want to operate on.
 *
 * Context after the Project Workspace integration:
 *
 *   - A project's `workspace/` directory can contain several Git
 *     repositories (`peldrun/`, `another-repo/`, ...), and every
 *     chat in that project sees the same set.
 *
 *   - Most Source Control operations (diff, commit, push, browse)
 *     target a SINGLE repository. The user therefore needs an
 *     explicit way to say "this is the one I mean" that persists
 *     across the panel's tabs.
 *
 *   - The store already tracks that choice (`activeWorkspaceId`).
 *     This component's job is to present the list, let the user
 *     pick, and write the choice into the store.
 *
 * Design notes:
 *
 *   1. The selector is PURELY presentational. Data fetching lives
 *      in `sourceControlClient` and the source of truth for the
 *      selection lives in `useSourceControlStore`. Neither is
 *      duplicated here: a fetch pushes the results in via
 *      `setAvailableWorkspaces`, and a selection writes via
 *      `setActiveWorkspace`. Every other view of the same state
 *      therefore updates automatically.
 *
 *   2. The component accepts BOTH `chatId` and `projectId`. The
 *      caller provides whichever it has:
 *        - `chatId`    — Manual Mode, Browse tab, side panel
 *                        inside a chat.
 *        - `projectId` — project dashboard, standalone panel
 *                        without a chat context.
 *      Providing both is allowed and the chat-scoped list is
 *      preferred (a chat's project is the same either way, but
 *      the chat-scoped endpoint applies the chat's project
 *      resolution rules and is therefore more accurate when the
 *      project entry itself has been moved or renamed).
 *
 *   3. Two rendering modes:
 *        - `compact` (default `false`) — a single dropdown
 *          button. Suitable for the header of `GitBrowserPanel`
 *          where the workspace chips already occupy the row.
 *        - expanded — a vertical list of cards. Suitable for the
 *          first step of Manual Mode, where the user is choosing
 *          the repository they want to work on.
 *
 *   4. Loading, error, and empty states are handled in-place.
 *      The empty state offers a `onCreateRequest` callback so
 *      the caller can open the create-workspace flow without
 *      this component needing to know how that flow is
 *      implemented.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  FolderGit2,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import { sourceControlClient } from "../api/source-control-client";
import { useSourceControlStore } from "../state/source-control-store";
import type { WorkspaceResponse } from "../api/schemas";

export interface WorkspaceSelectorProps {
  /**
   * Chat whose visible repositories are listed. Takes precedence
   * over `projectId` when both are provided.
   */
  chatId?: string | null;
  /**
   * Project whose hosted repositories are listed. Used when
   * `chatId` is absent, or when the caller wants the project's
   * complete list regardless of chat context.
   */
  projectId?: string | null;
  /**
   * Called after a selection is committed to the store. The
   * argument is the full `WorkspaceResponse` so the caller does
   * not need to look it up again.
   */
  onSelect?: (workspace: WorkspaceResponse) => void;
  /**
   * Called when the user clicks "Create workspace" from the
   * empty state. When omitted, the empty state renders a hint
   * instead of a button (useful when the caller wants to drive
   * the flow from a different part of the UI).
   */
  onCreateRequest?: () => void;
  /**
   * Extra class names for the root wrapper. Useful for margins
   * inside a header bar or a card.
   */
  className?: string;
  /**
   * When true, render a single dropdown button instead of a
   * vertical list. The expanded mode is the default so the
   * component is usable from a first-run onboarding screen
   * without additional styling.
   */
  compact?: boolean;
  /**
   * Optional controlled value. When set, the component reflects
   * this value in the UI without requiring the caller to sync
   * the store. Most callers should omit it and rely on the
   * store's `activeWorkspaceId`, which is what every other view
   * reads.
   */
  value?: string | null;
}

/** Human label for a workspace: repository id + branch. */
function workspaceLabel(ws: WorkspaceResponse): string {
  const repo = ws.repository_id || "(unknown repository)";
  const branch = ws.current_branch || "main";
  return `${repo} · ${branch}`;
}

/** Short repo name derived from `repository_id`. */
function repositoryShortName(repoId: string): string {
  if (!repoId) return "(unknown)";
  // The backend stores repository_id as the stable id, or as a
  // slug like "owner/repo". The trailing segment is what users
  // recognize.
  const parts = repoId.split("/");
  return parts[parts.length - 1] || repoId;
}

export function WorkspaceSelector({
  chatId,
  projectId,
  onSelect,
  onCreateRequest,
  className,
  compact = false,
  value,
}: WorkspaceSelectorProps) {
  // Store bindings.
  //
  // `availableWorkspaces` is the canonical list; `activeWorkspaceId`
  // is the canonical selection. `setLoadingWorkspaces` and
  // `setWorkspacesError` keep the loading/error state shared so a
  // second instance of this selector (for example, one in the
  // header and one in an onboarding card) shows the same status.
  const availableWorkspaces = useSourceControlStore(
    (s) => s.availableWorkspaces
  );
  const storeActiveId = useSourceControlStore(
    (s) => s.activeWorkspaceId
  );
  const isLoading = useSourceControlStore(
    (s) => s.isLoadingWorkspaces
  );
  const error = useSourceControlStore((s) => s.workspacesError);
  const setAvailableWorkspaces = useSourceControlStore(
    (s) => s.setAvailableWorkspaces
  );
  const setActiveWorkspace = useSourceControlStore(
    (s) => s.setActiveWorkspace
  );
  const setLoadingWorkspaces = useSourceControlStore(
    (s) => s.setLoadingWorkspaces
  );
  const setWorkspacesError = useSourceControlStore(
    (s) => s.setWorkspacesError
  );

  // The controlled value wins when provided. Otherwise the store
  // value is authoritative. This makes the component usable in
  // both "connected to global state" and "isolated" contexts.
  const selectedId = value !== undefined ? value : storeActiveId;

  // Local UI state (dropdown open). Kept outside the store
  // because it is purely a rendering concern: two instances of
  // the selector do not need to share whether their menus are
  // open.
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Fetch the list. `chatId` wins over `projectId` because the
  // chat-scoped endpoint resolves the project through the chat
  // record and is therefore the more accurate source when the
  // project's own entry has moved.
  const fetchWorkspaces = useCallback(async () => {
    if (!chatId && !projectId) {
      // No context to fetch against. Clear whatever is there so
      // the caller doesn't render a stale list from a previous
      // chat.
      setAvailableWorkspaces([]);
      return;
    }

    setLoadingWorkspaces(true);
    setWorkspacesError(null);

    try {
      const list = chatId
        ? await sourceControlClient.listWorkspacesByChat(chatId)
        : await sourceControlClient.listWorkspacesByProject(
            projectId as string
          );
      setAvailableWorkspaces(list);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to load available workspaces.";
      setWorkspacesError(message);
      // Deliberately do NOT clear `availableWorkspaces` on
      // error: a transient network failure should not blank
      // the user's selection. The error banner renders above
      // the still-usable list.
    } finally {
      setLoadingWorkspaces(false);
    }
  }, [
    chatId,
    projectId,
    setAvailableWorkspaces,
    setLoadingWorkspaces,
    setWorkspacesError,
  ]);

  // Fetch on mount and whenever the context changes.
  useEffect(() => {
    void fetchWorkspaces();
  }, [fetchWorkspaces]);

  // Close the dropdown when clicking outside. Standard "click-
  // outside" pattern; registered only while the menu is open so
  // we do not add a permanent document listener.
  useEffect(() => {
    if (!isOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (
        rootRef.current &&
        !rootRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
    };
  }, [isOpen]);

  const selectedWorkspace = useMemo(
    () =>
      availableWorkspaces.find(
        (w) => w.workspace_id === selectedId
      ) ?? null,
    [availableWorkspaces, selectedId]
  );

  const handleSelect = (ws: WorkspaceResponse) => {
    setActiveWorkspace(ws.workspace_id);
    setIsOpen(false);
    onSelect?.(ws);
  };

  // ---- Shared fragments ----

  const renderLoading = () =>
    compact ? (
      <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
        <Loader2 size={12} className="animate-spin" />
        <span>Loading…</span>
      </div>
    ) : (
      <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
        <Loader2 size={14} className="animate-spin" />
        <span>Loading available workspaces…</span>
      </div>
    );

  const renderError = () => (
    <div
      className={
        compact
          ? "flex items-center gap-1 px-2 py-1 text-xs text-red-700"
          : "flex items-start gap-2 rounded-md bg-red-50 border border-red-200 p-3 text-xs text-red-800"
      }
    >
      <AlertCircle
        size={compact ? 12 : 14}
        className="shrink-0 mt-0.5"
      />
      <span className="flex-1">{error}</span>
      <button
        type="button"
        onClick={() => void fetchWorkspaces()}
        className="text-xs underline hover:no-underline"
        title="Retry"
      >
        Retry
      </button>
    </div>
  );

  const renderEmpty = () => (
    <div
      className={
        compact
          ? "px-2 py-1 text-xs text-muted-foreground"
          : "flex flex-col items-center gap-2 rounded-md border border-dashed border-border p-6 text-center"
      }
    >
      <FolderGit2
        size={compact ? 12 : 28}
        className="text-muted-foreground"
      />
      <p className="text-xs text-muted-foreground">
        No workspace yet.
      </p>
      {onCreateRequest && (
        <button
          type="button"
          onClick={onCreateRequest}
          className="mt-1 inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus size={12} />
          Create workspace
        </button>
      )}
    </div>
  );

  // ---- Compact rendering ----

  if (compact) {
    if (isLoading && availableWorkspaces.length === 0) {
      return <div className={className}>{renderLoading()}</div>;
    }
    if (error && availableWorkspaces.length === 0) {
      return <div className={className}>{renderError()}</div>;
    }
    if (availableWorkspaces.length === 0) {
      return <div className={className}>{renderEmpty()}</div>;
    }

    return (
      <div
        ref={rootRef}
        className={`relative inline-block ${className ?? ""}`}
      >
        <button
          type="button"
          onClick={() => setIsOpen((o) => !o)}
          className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
          title="Select workspace"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
        >
          <FolderGit2 size={12} className="text-muted-foreground" />
          <span className="max-w-[180px] truncate">
            {selectedWorkspace
              ? repositoryShortName(
                  selectedWorkspace.repository_id
                )
              : "(select repository)"}
          </span>
          {selectedWorkspace && (
            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
              <GitBranch size={10} />
              {selectedWorkspace.current_branch}
            </span>
          )}
          <ChevronDown
            size={12}
            className={`text-muted-foreground transition-transform ${
              isOpen ? "rotate-180" : ""
            }`}
          />
        </button>

        {isOpen && (
          <div
            role="listbox"
            className="absolute z-30 mt-1 min-w-[220px] max-w-[320px] rounded-md border border-border bg-popover text-popover-foreground shadow-md"
          >
            {availableWorkspaces.map((ws) => {
              const isActive = ws.workspace_id === selectedId;
              return (
                <button
                  key={ws.workspace_id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => handleSelect(ws)}
                  className={`flex w-full items-start gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted ${
                    isActive ? "bg-muted" : ""
                  }`}
                >
                  <FolderGit2
                    size={12}
                    className="mt-0.5 shrink-0 text-muted-foreground"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                      <span className="truncate font-medium">
                        {repositoryShortName(ws.repository_id)}
                      </span>
                      {ws.is_dirty && (
                        <span
                          className="shrink-0 rounded-sm bg-amber-100 px-1 text-[9px] uppercase text-amber-800"
                          title="Uncommitted changes"
                        >
                          dirty
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <GitBranch size={9} />
                      <span className="truncate">
                        {ws.current_branch || "main"}
                      </span>
                    </div>
                  </div>
                  {isActive && (
                    <span className="shrink-0 text-[10px] text-primary">
                      selected
                    </span>
                  )}
                </button>
              );
            })}

            {onCreateRequest && (
              <div className="border-t border-border">
                <button
                  type="button"
                  onClick={() => {
                    setIsOpen(false);
                    onCreateRequest();
                  }}
                  className="flex w-full items-center gap-1 px-2 py-1.5 text-xs text-primary hover:bg-muted"
                >
                  <Plus size={12} />
                  New workspace
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ---- Expanded rendering ----

  return (
    <div className={`space-y-2 ${className ?? ""}`}>
      {isLoading && renderLoading()}
      {!isLoading && error && renderError()}
      {!isLoading && !error && availableWorkspaces.length === 0 &&
        renderEmpty()}

      {availableWorkspaces.length > 0 && (
        <ul className="space-y-1">
          {availableWorkspaces.map((ws) => {
            const isActive = ws.workspace_id === selectedId;
            return (
              <li key={ws.workspace_id}>
                <button
                  type="button"
                  onClick={() => handleSelect(ws)}
                  className={`flex w-full items-start gap-2 rounded-md border p-2 text-left text-xs transition-colors ${
                    isActive
                      ? "border-primary bg-primary/5"
                      : "border-border bg-card hover:bg-muted"
                  }`}
                >
                  <FolderGit2
                    size={14}
                    className="mt-0.5 shrink-0 text-muted-foreground"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                      <span className="truncate font-medium">
                        {repositoryShortName(ws.repository_id)}
                      </span>
                      {ws.is_dirty && (
                        <span
                          className="shrink-0 rounded-sm bg-amber-100 px-1 text-[9px] uppercase text-amber-800"
                          title="Uncommitted changes"
                        >
                          dirty
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <GitBranch size={10} />
                      <span className="truncate">
                        {ws.current_branch || "main"}
                      </span>
                      <span className="mx-1">·</span>
                      <span className="truncate">{ws.repository_id}</span>
                    </div>
                    <div className="mt-0.5 font-mono text-[9px] text-muted-foreground truncate">
                      {ws.workspace_id}
                    </div>
                  </div>
                  {isActive && (
                    <span className="shrink-0 self-center text-[10px] font-medium text-primary">
                      Selected
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {availableWorkspaces.length > 0 && (
        <div className="flex items-center justify-between pt-1 text-[10px] text-muted-foreground">
          <span>
            {availableWorkspaces.length} workspace
            {availableWorkspaces.length === 1 ? "" : "s"} available
          </span>
          <div className="flex items-center gap-2">
            {onCreateRequest && (
              <button
                type="button"
                onClick={onCreateRequest}
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <Plus size={10} />
                Create new
              </button>
            )}
            <button
              type="button"
              onClick={() => void fetchWorkspaces()}
              disabled={isLoading}
              className="inline-flex items-center gap-1 hover:underline disabled:opacity-50"
            >
              <RefreshCw
                size={10}
                className={isLoading ? "animate-spin" : ""}
              />
              Refresh
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default WorkspaceSelector;

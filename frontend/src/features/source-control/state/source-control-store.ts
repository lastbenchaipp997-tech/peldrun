// frontend/src/features/source-control/state/source-control-store.ts

import { create } from "zustand";
import {
  OperationResponse,
  DiffSummaryResponse,
  WorkspaceResponse,
} from "../api/schemas";
import {
  WorkbenchPanelTab,
  SourceControlViewMode,
  SourceControlUiError,
} from "../types";

/**
 * Interface defining the Source Control Zustand store state and actions.
 */
interface SourceControlStoreState {
  // --- Panel & View State ---
  /** Indicates if the global right-side workbench panel is visible */
  isPanelOpen: boolean;

  /** The currently active tab in the right-side panel (e.g., 'preview', 'source-control') */
  activeTab: WorkbenchPanelTab;

  /** The specific view mode within the Source Control tab (idle, review, timeline) */
  viewMode: SourceControlViewMode;

  // --- Active Operation Context ---
  /** The ID of the operation currently loaded or being reviewed */
  activeOperationId: string | null;

  /** The full operation record fetched from the backend */
  activeOperation: OperationResponse | null;

  /** The diff summary fetched for the active operation */
  activeDiff: DiffSummaryResponse | null;

  // --- UI Error State ---
  /** Structured error object for UI rendering (e.g., 412 Stale Review, 401 Auth Required) */
  error: SourceControlUiError | null;

  // --- Actions ---
  /** Opens the workbench panel, optionally setting the active tab */
  openPanel: (tab?: WorkbenchPanelTab) => void;

  /** Closes the workbench panel */
  closePanel: () => void;

  /** Sets the active tab in the workbench panel */
  setActiveTab: (tab: WorkbenchPanelTab) => void;

  /** Sets the view mode within the Source Control tab */
  setViewMode: (mode: SourceControlViewMode) => void;

  /** Sets the active operation data and updates the view mode accordingly */
  setActiveOperation: (operation: OperationResponse | null) => void;

  /** Sets the active diff data */
  setActiveDiff: (diff: DiffSummaryResponse | null) => void;

  /** Sets an error to be displayed in the UI */
  setError: (error: SourceControlUiError | null) => void;

  /** Clears all active operation context and resets to idle state */
  resetOperationContext: () => void;

  // --- Workspace Selection ---
  //
  // After the Project Workspace integration, a single chat can
  // see SEVERAL repositories (all the repos the project hosts).
  // The user picks ONE of them for the operations that target a
  // single repository: diff, commit, push, and the Browse view.
  //
  // The store does NOT fetch; components (or a dedicated
  // `useWorkspaces` hook) call `sourceControlClient.list*` and
  // push the results in via `setAvailableWorkspaces`. This is the
  // same "dumb store" pattern the rest of this file follows.

  /**
   * Every workspace visible to the current chat (or project).
   *
   * Empty when no fetch has run yet, or when the chat has no
   * workspace. Consumers MUST distinguish the two via
   * `isLoadingWorkspaces` / `workspacesError`.
   */
  availableWorkspaces: WorkspaceResponse[];

  /**
   * The workspace the user selected for single-repo operations.
   *
   * Fallback priority for consumers (in order):
   *   1. `activeWorkspaceId` (this field), when set.
   *   2. `activeOperation?.workspace_id`, when an operation is
   *      being reviewed in Agent Mode.
   *   3. The first entry in `availableWorkspaces`, when there is
   *      exactly one workspace.
   *
   * `BrowsePanel` and any new workspace-aware component SHOULD
   * use this fallback chain so that switching between Agent Mode
   * and Browse Mode stays coherent.
   */
  activeWorkspaceId: string | null;

  /** True while a workspace list fetch is in flight. */
  isLoadingWorkspaces: boolean;

  /** Error message from the most recent workspace list fetch. */
  workspacesError: string | null;

  /**
   * Replace the available-workspaces list.
   *
   * If `activeWorkspaceId` is no longer present in the new list
   * (because the workspace was deleted, or because the chat
   * changed), the selection is automatically snapped to the first
   * entry (or cleared to `null` when the list is empty). This
   * invariant keeps the two fields consistent without forcing
   * every caller to remember to clean up.
   *
   * The fetch error is cleared on every successful update: a new
   * non-empty list means the last error is obsolete.
   */
  setAvailableWorkspaces: (workspaces: WorkspaceResponse[]) => void;

  /** Explicitly select (or clear with `null`) the active workspace. */
  setActiveWorkspace: (workspaceId: string | null) => void;

  /** Toggle the loading flag. Called at the start/end of a fetch. */
  setLoadingWorkspaces: (loading: boolean) => void;

  /** Record or clear the most recent workspace fetch error. */
  setWorkspacesError: (error: string | null) => void;

  /**
   * Forget the workspace list and the current selection.
   *
   * Called when the user switches chats (or closes the panel) so
   * that the next mount does not briefly render the previous
   * chat's repositories. This is a state-only operation: the
   * fetch is performed separately by the caller.
   */
  clearWorkspaces: () => void;
}

/**
 * Zustand store for managing the Source Control UI state.
 * This store is intentionally kept "dumb" (it does not fetch data).
 * Data fetching and backend interaction are handled by custom hooks (e.g., useOperation).
 */
export const useSourceControlStore = create<SourceControlStoreState>((set) => ({
  // --- Initial State ---
  isPanelOpen: false,
  activeTab: "preview",
  viewMode: "idle",
  activeOperationId: null,
  activeOperation: null,
  activeDiff: null,
  error: null,

  // --- Actions ---
  openPanel: (tab) =>
    set((state) => ({
      isPanelOpen: true,
      activeTab: tab ?? state.activeTab,
    })),

  closePanel: () => set({ isPanelOpen: false }),

  setActiveTab: (tab) => set({ activeTab: tab }),

  setViewMode: (mode) => set({ viewMode: mode }),

  setActiveOperation: (operation) =>
    set({
      activeOperation: operation,
      activeOperationId: operation ? operation.operation_id : null,
      // Automatically switch to review mode if the operation requires approval
      viewMode: operation
        ? operation.current_state === "review_required"
          ? "review"
          : "timeline"
        : "idle",
    }),

  setActiveDiff: (diff) => set({ activeDiff: diff }),

  setError: (error) => set({ error }),

  resetOperationContext: () =>
    set({
      viewMode: "idle",
      activeOperationId: null,
      activeOperation: null,
      activeDiff: null,
      error: null,
    }),

  // --- Workspace Selection ---
  availableWorkspaces: [],
  activeWorkspaceId: null,
  isLoadingWorkspaces: false,
  workspacesError: null,

  setAvailableWorkspaces: (workspaces) =>
    set((state) => {
      // Preserve the user's selection when the workspace is
      // still present. Otherwise snap to the first entry, or
      // clear when the list is empty. This guarantees
      // `activeWorkspaceId` is either null or points at a real
      // workspace in `availableWorkspaces` — no component ever
      // needs to defend against a dangling id.
      const stillPresent =
        state.activeWorkspaceId !== null &&
        workspaces.some(
          (w) => w.workspace_id === state.activeWorkspaceId
        );
      const nextActive = stillPresent
        ? state.activeWorkspaceId
        : workspaces.length > 0
          ? workspaces[0].workspace_id
          : null;

      return {
        availableWorkspaces: workspaces,
        activeWorkspaceId: nextActive,
        // A successful fetch is authoritative: clear any
        // previous error.
        workspacesError: null,
      };
    }),

  setActiveWorkspace: (workspaceId) =>
    set({ activeWorkspaceId: workspaceId }),

  setLoadingWorkspaces: (loading) =>
    set({ isLoadingWorkspaces: loading }),

  setWorkspacesError: (error) =>
    set({ workspacesError: error }),

  clearWorkspaces: () =>
    set({
      availableWorkspaces: [],
      activeWorkspaceId: null,
      isLoadingWorkspaces: false,
      workspacesError: null,
    }),
}));

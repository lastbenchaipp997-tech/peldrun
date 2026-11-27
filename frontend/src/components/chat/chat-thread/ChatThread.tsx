//frontend\src\components\chat\chat-thread\ChatThread.tsx

"use client";

/**
 * ChatThread container component.
 *
 * Owns the high-level orchestration of a chat session's rendering:
 *  - Iterates historical turns and renders each via `HistoricalTurn`.
 *  - Renders the current active turn (prompt + stepper + subtasks).
 *  - Displays delegation approval cards, live running indicator, and the
 *    final deliverable when the current run completes.
 *  - Detects a pending human-in-the-loop tool call and mounts the
 *    interactive `HumanInputCard` accordingly.
 *  - Exposes lifecycle actions (Regenerate).
 *
 * All state is passed in from the parent; this component is a pure
 * presentational shell that delegates to focused sub-components.
 */

import React, { useEffect } from "react";
import { ArrowDown } from "lucide-react";
import { useStickToBottom } from "use-stick-to-bottom";
import { useProviderBadge } from "@/lib/providerBadge";
import { ProviderModelBadge } from "./ProviderModelBadge";
import { ChatTimeline, StepEvent } from "../chat-timeline";
import { ChatDeliverable } from "../chat-deliverable";
import { DelegationApprovalCard } from "../DelegationApprovalCard";
import { SubtaskTree } from "../SubtaskTree";
import { UserMessageBubble } from "./UserMessageBubble";
import { HistoricalTurn } from "./HistoricalTurn";
import { HumanInputCard } from "./HumanInputCard";
import { LiveStatusIndicator } from "./LiveStatusIndicator";
import { ChatReasoningPanel } from "./ChatReasoningPanel";
import { useHumanToolDetection } from "./useHumanToolDetection";
import type { ChatThreadProps } from "./types";

import { ChatOperationCard } from "@/features/source-control/components/ChatOperationCard";
import { extractOperationFromSteps, filterApprovalSteps } from "./utils";

/**
 * Groups visible step events by their numeric step index.
 *
 * Events without content or a tool name are dropped to avoid rendering
 * empty placeholders. The returned record preserves insertion order.
 */
function groupStepEvents(evts: StepEvent[]): Record<number, StepEvent[]> {
  const seen = new Set<string>();
  return evts.reduce((acc, s) => {
    const contentKey =
      typeof s.content === "string" ? s.content.trim() : "";
    const dedupKey = `${s.step}|${s.type}|${s.toolName || ""}|${contentKey}`;
    if (seen.has(dedupKey)) return acc;
    seen.add(dedupKey);

    const isVisible = contentKey !== "" || Boolean(s.toolName);
    if (!isVisible) return acc;
    if (!acc[s.step]) acc[s.step] = [];
    acc[s.step].push(s);
    return acc;
  }, {} as Record<number, StepEvent[]>);
}

export function ChatThread({
  historyTurns,
  chatId,
  submittedPrompt,
  submittedFiles = [],
  sessionTimestamp,
  humanQuery,
  humanAnswer,
  setHumanAnswer,
  onSendHumanAnswer,
  execMode,
  activeGroupedSteps,
  chatReasoningText: chatReasoningTextProp,
  currentStepNum,
  status,
  elapsedSeconds,
  finalResult,
  producedFiles,
  copiedSection,
  copyText,
  expandedSteps,
  toggleStep,
  onSelectFile,
  showRawTrace,
  setShowRawTrace,
  getLiveStatusMessage,
  activeModelName = "Assistant",
  activeProvider,
  currentTurnProvider,
  currentTurnModel,
  tokensUsed,
  costUsd,
  latencyMs,
  tokensPerSecond,
  activeChildRuns = {},
  pendingApprovals = {},
  onApproveDelegation,
  onRejectDelegation,
  onCancelSubtask,
  onRegenerate,
  onOpenReview,
  // v3: forwarded through HistoricalTurn and ChatDeliverable into every
  // MarkdownRenderer, then into CardRuntimeContext. Enables ```ui card
  // prompt-action buttons to dispatch a new message.
  onSendPrompt,
}: ChatThreadProps) {
  // Two distinct provider values flow into this component:
  //
  //   * `activeProvider` — the user's CURRENT EngineSelector selection
  //     (from useAppStorage). Passed down to HistoricalTurn as the
  //     fallback for pre-upgrade turns that lack a per-turn snapshot.
  //
  //   * `currentTurnProvider` — the snapshot captured when the current
  //     run STARTED (from ChatContainer's `runStartProviderRef`). Used
  //     for the CURRENT turn's header, so the label does NOT change
  //     just because the user picked a different engine for the NEXT
  //     message. Falls back to `activeProvider` when undefined (for
  //     external consumers that do not track the snapshot).
  //
  // Using the run-start snapshot for the current turn header matches
  // ChatGPT / Claude behavior: past messages keep their original
  // model label, while new selections only apply to future messages.
  const displayProvider = currentTurnProvider ?? activeProvider;
  const displayModel = currentTurnModel ?? activeModelName;
  const displayProviderBadge = useProviderBadge(displayProvider);

  // Stick-to-bottom scroll owner. Replaces the two competing
  // `scrollIntoView({ smooth })` calls that previously lived here and
  // in ChatContainer. The library pauses "stick" only while the user
  // is scrolled up (reading), and resumes automatically once they
  // return to the bottom — so streaming never fights the user's input.
  const { scrollRef, contentRef, scrollToBottom, isAtBottom } =
    useStickToBottom({ resize: "smooth", initial: "instant" });

  // Sending is an explicit "take me to the bottom" intent, so it
  // re-engages the lock even if the user had scrolled up earlier.
  useEffect(() => {
    if (submittedPrompt) void scrollToBottom();
  }, [submittedPrompt, historyTurns.length, scrollToBottom]);

  // Detect whether the agent is currently paused waiting for human input.
  const activeStepsList = Object.values(activeGroupedSteps || {}).flat();
  const { isHumanWaiting, detectedPrompt, detectedOptions } = useHumanToolDetection(
    activeStepsList,
    humanQuery,
    status
  );

  // Determine whether the current final result looks like a raw trace dump.
  const isCurrentRawTrace = Boolean(
    finalResult &&
      (finalResult.includes("Observed output of cmd") || finalResult.startsWith("Step 1:"))
  );

  // Most recent meaningful thought from the active step stream.
  const currentLastThought = [...activeStepsList]
    .reverse()
    .find(
      (s) =>
        s.type === "thought" &&
        s.content &&
        !s.content.startsWith("Step ") &&
        !s.content.startsWith("terminate(")
    );

  // [CHAT-REASONING] The reasoning stream is provided directly by
  // ChatContainer as a dedicated prop. Chat mode does NOT use the
  // step-based timeline at all — `activeGroupedSteps` is `{}` in
  // chat mode (see ChatContainer's `activeGroupedSteps` prop), so
  // deriving the reasoning from `activeStepsList` would always yield
  // an empty string.
  //
  // The state lives in ChatContainer (populated by use-sse-stream's
  // `setChatReasoningText`), which isolates it from the agent-mode
  // `steps` array and keeps the two modes completely independent.
  const chatReasoningText = chatReasoningTextProp || "";

  const activeApprovalList = Object.values(pendingApprovals || {});

  const activeOperation = extractOperationFromSteps(activeStepsList);

  // The final result is surfaced separately as `<ChatDeliverable>`.
  // Some backends also emit the same content as an observation
  // event in the last step, which causes the final message to
  // render twice: once inside the timeline, once inside the
  // deliverable. Filter that observation out of the timeline.
  const finalResultTrimmed =
    typeof finalResult === "string" ? finalResult.trim() : "";

  const filteredGroupedSteps = Object.fromEntries(
    Object.entries(activeGroupedSteps || {})
      .map(([stepNum, steps]) => {
        const cleaned = (steps as StepEvent[]).filter((s) => {
          // image_results steps are rendered separately by ChatThread
          // above the timeline, so exclude them from the accordion
          // content to prevent visual duplication.
          if (s.type === "image_results") return false;

          if (!finalResultTrimmed) return true;
          if (s.type !== "observation") return true;
          const content =
            typeof s.content === "string" ? s.content.trim() : "";
          if (!content) return true;
          return !(
            content === finalResultTrimmed ||
            content.startsWith(finalResultTrimmed) ||
            finalResultTrimmed.startsWith(content)
          );
        });
        return [stepNum, filterApprovalSteps(cleaned)];
      })
      .filter(([_, steps]) => (steps as StepEvent[]).length > 0)
  );

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 font-sans"
      >
        <div ref={contentRef} className="w-full max-w-[900px] mx-auto space-y-6">
          {/* Historical Turns */}
        {historyTurns.map((turn, tIdx) => (
          // v4.1 FIX: append `-${tIdx}` unconditionally so the key is
          // ALWAYS unique, even when `turn.id` collides across turns.
          //
          // Root cause: `turn.id` can be duplicated when
          //   (a) the backend's `session.json` stores turns with
          //       `id: chat_id` (all turns share one chat-scoped id), or
          //   (b) `activeJobId` is stale during a rapid double-click on
          //       a ```ui card prompt action, so two archives fire with
          //       the same job id before the new run's id arrives.
          //
          // React's reconciliation on an append-only history does not
          // need stable ids across reorders — the list is only ever
          // appended to or truncated from the end — so `-${tIdx}` is a
          // safe disambiguator. `turn.jobId` remains the semantic id
          // used by regeneration.
          <div key={`${turn.id || "turn"}-${tIdx}`}>
            <HistoricalTurn
              turn={turn}
              tIdx={tIdx}
              chatId={chatId}
              copiedSection={copiedSection}
              copyText={copyText}
              expandedSteps={expandedSteps}
              toggleStep={toggleStep}
              onSelectFile={onSelectFile}
              showRawTrace={showRawTrace}
              setShowRawTrace={setShowRawTrace}
              activeModelName={activeModelName}
              activeProvider={activeProvider}
              onRegenerate={onRegenerate}
              // v3: forward to ChatDeliverable -> MarkdownRenderer so
              // card actions on historical turns remain functional.
              onSendPrompt={onSendPrompt}
            />
          </div>
        ))}

        {/* Current Active Turn Prompt */}
        {submittedPrompt && (
          <div className="space-y-4">
            <UserMessageBubble
              prompt={submittedPrompt}
              files={submittedFiles}
              timestamp={sessionTimestamp}
              copyId="user-prompt"
              copiedSection={copiedSection}
              onCopy={copyText}
              onSelectFile={onSelectFile}
              chatId={chatId}
            />
          </div>
        )}

        {/* Active Turn Identity Header (Model Name & Metadata) */}
        {submittedPrompt && (
          <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 pb-2">
            <ProviderModelBadge
              providerName={displayProvider}
              modelName={displayModel}
              providerBadge={displayProviderBadge}
              execMode={execMode}
              timestamp={sessionTimestamp}
            />
          </div>
        )}

        {/* Active Stepper (Agent Mode) — rendered below the header */}
        {execMode === "agent" &&
          Object.keys(filteredGroupedSteps).length > 0 && (
            <ChatTimeline
              prefix="active"
              groupedSteps={filteredGroupedSteps}
              isCurrentActive={true}
              currentStepNum={currentStepNum}
              isRunning={status === "running"}
              expandedSteps={expandedSteps}
              toggleStep={toggleStep}
            />
          )}

        {/* [CHAT-REASONING] Reasoning trace in Chat mode.
            Rendered above the deliverable bubble so the user sees the
            model "thinking out loud" while it works, then the answer
            below. Auto-expands during streaming, auto-collapses 1.5s
            after completion (one final look), and is manually
            re-openable. Only rendered in chat mode — agent mode uses
            ChatTimeline instead. */}
        {execMode === "chat" && chatReasoningText.trim() && (
          <ChatReasoningPanel
            thoughtContent={chatReasoningText}
            isRunning={status === "running"}
          />
        )}

        {/* Image galleries are injected into the final answer's
            `result_text` as an ``image_gallery`` markdown block by
            the backend (peldrun_engine.py for agent mode,
            dispatcher.py for chat mode). They render inside
            <ChatDeliverable> via MarkdownRenderer, not as a
            standalone block here. This keeps the gallery visually
            part of the model's answer, matching chat mode. */}

        {activeOperation && onOpenReview && (
          <ChatOperationCard
            operation={activeOperation}
            onOpenReview={onOpenReview}
          />
        )}

        {/* Active Delegation Approval Cards */}
        {activeApprovalList.length > 0 && onApproveDelegation && onRejectDelegation && (
          <div className="space-y-2">
            {activeApprovalList.map((approval) => (
              <DelegationApprovalCard
                key={approval.approvalRequestId}
                approval={approval}
                onApprove={onApproveDelegation}
                onReject={onRejectDelegation}
                disabled={status !== "running"}
              />
            ))}
          </div>
        )}

        {/* Active Multi-Agent Subtask Observability Tree */}
        {Object.keys(activeChildRuns || {}).length > 0 && (
          <SubtaskTree
            childRuns={activeChildRuns}
            onCancelSubtask={onCancelSubtask}
            onSelectFile={onSelectFile}
          />
        )}

        {/* Interactive Human-in-the-Loop Dialog Suspension Card */}
        {isHumanWaiting && (
          <HumanInputCard
            isHumanWaiting={isHumanWaiting}
            detectedPrompt={detectedPrompt || ""}
            detectedOptions={detectedOptions}
            humanAnswer={humanAnswer}
            setHumanAnswer={setHumanAnswer}
            onSendHumanAnswer={onSendHumanAnswer}
          />
        )}

        {/* Deliverable for Completed / Current Turn */}
        {finalResult && (
          <ChatDeliverable
            chatId={chatId}
            finalResult={finalResult}
            status={status === "failed" ? "failed" : "completed"}
            isTurnRawTrace={isCurrentRawTrace}
            lastThoughtContent={currentLastThought ? currentLastThought.content : undefined}
            producedFiles={producedFiles}
            onSelectFile={onSelectFile}
            copiedSection={copiedSection}
            onCopy={copyText}
            execMode={execMode}
            showRawTrace={showRawTrace}
            setShowRawTrace={setShowRawTrace}
            modelName={activeModelName}
            timestamp={sessionTimestamp}
            tokensUsed={tokensUsed}
            costUsd={costUsd}
            latencyMs={latencyMs}
            tokensPerSecond={tokensPerSecond}
            hideHeader={true}
            onRegenerate={
              status !== "running" && onRegenerate
                ? () => onRegenerate(-1)
                : undefined
            }
            // v3: forward to MarkdownRenderer for card actions in the
            // current turn's deliverable.
            onSendPrompt={onSendPrompt}
          />
        )}

        {/* Live Running Indicator — pinned to the bottom of the active thread.
            Pause was removed in Phase H — no LLM provider supports
            true streaming pause, so the button was misleading. Stop
            (available in ChatSubHeader) is the only lifecycle control. */}
        {status === "running" && !isHumanWaiting && activeApprovalList.length === 0 && (
          <LiveStatusIndicator
            message={getLiveStatusMessage()}
            elapsedSeconds={elapsedSeconds}
          />
        )}

        </div>
      </div>

      {!isAtBottom && (
        <button
          type="button"
          onClick={() => void scrollToBottom()}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 inline-flex items-center
          gap-1.5 rounded-full border border-card bg-card px-3 py-1.5 font-mono text-xs text-blck shadow-xl hover:text-foreground"
        >
          <ArrowDown size={14} />
          {status === "running" ? "Jump to live" : "Jump to latest"}
        </button>
      )}
    </div>
  );
}

export default ChatThread;

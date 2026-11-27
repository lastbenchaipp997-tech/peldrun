// frontend/src/components/generative-ui/catalog/ChatRunStateContext.ts
"use client";

//
// Run-state channel between the chat thread and interactive card blocks.
//
// Why a dedicated context instead of more props:
//   Cards are rendered deep inside ChatDeliverable -> MarkdownRenderer ->
//   PeldrunCardBlock. Threading run flags through every intermediate
//   component would touch files that have no business knowing about
//   cards. A context set once in ChatThread reaches them directly, and
//   the default value keeps every other render site (previews, tests,
//   anything outside ChatThread) behaving exactly as before.
//
// Two flags, deliberately distinct:
//   busy : a run is active (running / cancelling). The host rejects new
//          sends in this state, so interactive cards must not offer them.
//          Applies to EVERY card in the thread, historical or current.
//   live : THIS card belongs to the turn that is still being produced
//          (streaming text, tool calls, backend post-processing such as
//          the image gallery). Only the current turn is ever live.
//          Archived turns are complete by definition.
//   answered : THIS card belongs to an archived turn that already has a
//          later turn after it. Interactive blocks in it (forms) were
//          used or superseded and must not be submitted again. A form
//          component is re-created when its turn moves from "current" to
//          "archived", so its own state cannot remember a submit; the
//          position of the turn in the thread can.

import { createContext, useContext } from "react";

export interface ChatRunState {
  /** A run is active; sending a new message would be rejected. */
  busy: boolean;
  /** The enclosing turn is still being produced. */
  live: boolean;
  /**
   * The enclosing turn is archived and a later turn exists. Optional so
   * providers that predate it stay valid; omitted means false.
   */
  answered?: boolean;
}

/** Neutral value used outside a provider: nothing busy, nothing live. */
export const IDLE_CHAT_RUN_STATE: ChatRunState = Object.freeze({
  busy: false,
  live: false,
});

export const ChatRunStateContext =
  createContext<ChatRunState>(IDLE_CHAT_RUN_STATE);

/** Reads the run state of the enclosing chat thread (idle if none). */
export function useChatRunState(): ChatRunState {
  return useContext(ChatRunStateContext);
}

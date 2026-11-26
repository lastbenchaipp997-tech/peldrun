"use client";

// Place at: frontend/src/components/chat/chat-container/hooks/use-text-delta-buffer.ts

import { useCallback, useEffect, useRef } from "react";

/**
 * Coalesces streamed text deltas and publishes them at most once per
 * animation frame (~60 Hz).
 *
 * Why this exists:
 *   `chunk` events used to call `setFinalResult(prev => prev + delta)`
 *   for EVERY token. All live-turn state lives in ChatContainer, so each
 *   token re-rendered the whole container (header, thread, composer,
 *   workspace panel, markdown renderer). Tool output was already batched
 *   by `useToolStreamBuffer`; answer text was not.
 *
 * API:
 *   push(delta)  — queue text; schedules one flush per frame.
 *   flush()      — publish whatever is queued right now (use before an
 *                  event that must see the text, e.g. `done`).
 *   discard()    — drop queued text without publishing. Use on:
 *                    * `final` / `error`  (they replace the whole text)
 *                    * `reset`            (retry starts from scratch)
 *                    * connect / close    (a previous run must never
 *                                          write into the next turn)
 *
 * All three functions have a stable identity, so they are safe to capture
 * in `useCallback(..., [])` closures such as `connectStream`.
 */
export function useTextDeltaBuffer(onFlush: (text: string) => void) {
  const bufferRef = useRef("");
  const frameRef = useRef<number | null>(null);
  const onFlushRef = useRef(onFlush);
  onFlushRef.current = onFlush;

  const cancelFrame = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const flush = useCallback(() => {
    cancelFrame();
    const text = bufferRef.current;
    if (!text) return;
    bufferRef.current = "";
    onFlushRef.current(text);
  }, [cancelFrame]);

  const push = useCallback(
    (delta: string) => {
      if (!delta) return;
      bufferRef.current += delta;
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null;
          flush();
        });
      }
    },
    [flush]
  );

  const discard = useCallback(() => {
    cancelFrame();
    bufferRef.current = "";
  }, [cancelFrame]);

  // Unmount: never publish into an unmounted tree.
  useEffect(() => discard, [discard]);

  return { push, flush, discard };
}

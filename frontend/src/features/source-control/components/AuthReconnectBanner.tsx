// frontend/src/features/source-control/components/AuthReconnectBanner.tsx

"use client";

import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { useSourceControlAuth } from "../hooks/useSourceControlAuth";
import { DeviceFlowDialog } from "./authentication/DeviceFlowDialog";
import { sourceControlClient } from "../api/source-control-client";

const AUTH_SOURCE_LABELS: Record<string, string> = {
  managed: "PELDRUN GitHub App",
  byoa: "Your OAuth App",
  legacy_unknown: "Legacy connection",
};

export function AuthReconnectBanner() {
  const auth = useSourceControlAuth();
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [localPhase, setLocalPhase] = useState<"idle" | "opening" | "waiting" | "success">("idle");
  const [connectError, setConnectError] = useState<string | null>(null);

  const [connectedInfo, setConnectedInfo] = useState<{ username: string; sourceLabel: string | null } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // Tracks whether the backend confirmed the current credential is rejected (HTTP 401).
  // Once true, connection records returned by listConnections() are treated as stale
  // until a new authorization completes successfully.
  const [tokenRejected, setTokenRejected] = useState(false);

  const pollTimerRef = useRef<number | null>(null);
  const lastConnRef = useRef<string | null>(null);

  useEffect(() => {
    void auth.refresh();
  }, []);

  // Fetch connection directly from API.
  // Skips while `tokenRejected` is true because listConnections() may still return a
  // stale record whose token is no longer valid.
  useEffect(() => {
    if (tokenRejected) {
      setConnectedInfo(null);
      return;
    }

    let isMounted = true;
    sourceControlClient.listConnections()
      .then((connections) => {
        if (!isMounted) return;
        const githubConn = connections.find((c) => c.provider === "github" && c.is_connected);
        if (githubConn) {
          setConnectedInfo({
            username: githubConn.username || githubConn.account_id || "unknown account",
            sourceLabel: AUTH_SOURCE_LABELS[githubConn.auth_source ?? ""] ?? null,
          });
          setNeedsReconnect(false);
        } else {
          setConnectedInfo(null);
        }
      })
      .catch((err) => {
        console.error("[AuthReconnectBanner] Failed to fetch connections:", err);
      });

    return () => { isMounted = false; };
  }, [auth.status, auth.deviceFlow.phase, tokenRejected]);

  // Only clear the reconnect state when the connection identity actually changes.
  // Relying on object identity caused `auth.refresh()` (triggered by a 401) to silently
  // reset `needsReconnect` while the credential was still invalid.
  useEffect(() => {
    const conn = auth.status?.providers?.github?.connection;
    if (!conn) {
      lastConnRef.current = null;
      return;
    }

    const connKey = `${conn.account_id ?? ""}:${conn.username ?? ""}`;
    if (lastConnRef.current === connKey) return;

    lastConnRef.current = connKey;
    setTokenRejected(false);
    setNeedsReconnect(false);
    setMessage(null);
    auth.dismissError(); // Clear auth hook errors

    // This forces SourceControlPanel to remount ManualModePanel, clearing the red error
    window.dispatchEvent(new CustomEvent("peldrun:auth-reconnected"));
  }, [auth.status?.providers?.github?.connection]);

  // Listen for 401s from the API client.
  // A 401 is authoritative: it means the stored credential was rejected, even if
  // listConnections() still reports an active connection for the account.
  useEffect(() => {
    const onAuthRequired = (e: Event) => {
      if (localPhase !== "idle" || auth.deviceFlow.phase !== "idle") return;

      const detail = (e as CustomEvent<{ message?: string }>).detail || {};
      setTokenRejected(true);
      setNeedsReconnect(true);
      setConnectedInfo(null);
      setMessage(detail.message || null);
      void auth.refresh();
    };
    window.addEventListener("peldrun:auth-required", onAuthRequired);
    return () => window.removeEventListener("peldrun:auth-required", onAuthRequired);
  }, [localPhase, auth.deviceFlow.phase]);

  // Monitor Device Flow for completion
  useEffect(() => {
    if (auth.deviceFlow.phase === "completed") {
      setTokenRejected(false);
      setNeedsReconnect(false);
      setMessage(null);
      setLocalPhase("success");
      setDismissed(false);
      void auth.refresh();

      window.setTimeout(() => {
        setLocalPhase("idle");
        window.dispatchEvent(new CustomEvent("peldrun:auth-reconnected"));
      }, 900);
    } else if (auth.deviceFlow.phase === "failed" || auth.deviceFlow.phase === "denied") {
      setConnectError(auth.deviceFlow.errorMessage || "Device Flow failed.");
    }
  }, [auth.deviceFlow.phase, auth.deviceFlow.errorMessage]);

  const handleReconnect = async () => {
    setConnectError(null);
    setLocalPhase("idle");
    setDismissed(false);

    const managedReady = auth.status?.providers?.github?.managed_ready ?? false;
    const byoaReady = auth.status?.providers?.github?.byoa_ready ?? false;

    if (managedReady) {
      void auth.startManagedFlow("github");
      return;
    }

    if (!byoaReady) {
      setConnectError("No authentication method is enabled. Please go to Integrations settings to enable Managed GitHub App or BYOA.");
      return;
    }

    setLocalPhase("opening");
    try {
      const res = await fetch("/api/source-control/connections/github/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "github" }),
      });

      if (!res.ok) throw new Error("Failed to start BYOA flow");
      const response = await res.json();

      const win = window.open(response.authorization_url, "_blank");
      if (!win) throw new Error("Pop-up blocked. Please allow pop-ups.");

      setLocalPhase("waiting");

      let attempts = 0;
      const tick = async () => {
        attempts++;
        const connections = await auth.refresh().then(() => true).catch(() => false);
        if (connections && auth.status?.providers?.github?.connection) {
          setTokenRejected(false);
          setNeedsReconnect(false);
          setLocalPhase("idle");
          setDismissed(false);
          window.dispatchEvent(new CustomEvent("peldrun:auth-reconnected"));
          return;
        }

        if (attempts >= 90) {
          setLocalPhase("idle");
          setConnectError("Connection timed out.");
          return;
        }
        pollTimerRef.current = window.setTimeout(tick, 2000);
      };
      void tick();
    } catch (err) {
      setLocalPhase("idle");
      setConnectError(err instanceof Error ? err.message : "Failed to start OAuth.");
    }
  };

  const showConnectedNotice =
    !dismissed &&
    !needsReconnect &&
    !tokenRejected &&
    connectedInfo !== null &&
    localPhase === "idle";

  if (!showConnectedNotice && !needsReconnect && auth.deviceFlow.phase === "idle") {
    return null;
  }

  return (
    <>
      {showConnectedNotice && connectedInfo && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-green-300 bg-green-50 text-xs text-green-900 shrink-0">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-green-700" />
          <div className="flex-1 min-w-0">
            <div className="font-medium truncate">
              Connected as <span className="font-semibold">{connectedInfo.username}</span>
              {connectedInfo.sourceLabel && (
                <span className="font-normal text-green-700"> · {connectedInfo.sourceLabel}</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="shrink-0 text-[11px] px-2 py-1 rounded border border-green-400 bg-green-100 hover:bg-green-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {needsReconnect && !showConnectedNotice && (
        <>
          {localPhase === "success" && (
            <div className="flex items-center gap-2 px-3 py-2 border-b border-green-300 bg-green-50 text-xs text-green-900 shrink-0">
              <CheckCircle2 className="w-4 h-4 shrink-0 text-green-700" />
              <span className="font-medium">Connected! Reloading…</span>
            </div>
          )}

          {localPhase === "opening" || localPhase === "waiting" ? (
            <div className="flex items-start gap-2 px-3 py-2 border-b border-blue-300 bg-blue-50 text-xs text-blue-900 shrink-0">
              <Loader2 className="w-4 h-4 shrink-0 mt-0.5 text-blue-700 animate-spin" />
              <div className="flex-1">
                <div className="font-medium">
                  {localPhase === "opening" ? "Opening GitHub…" : "Waiting for authorization…"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
                  setLocalPhase("idle");
                }}
                className="shrink-0 text-[11px] px-2 py-1 rounded border border-blue-400 bg-blue-100 hover:bg-blue-200"
              >
                Cancel
              </button>
            </div>
          ) : localPhase === "idle" && (
            <div className="flex items-start gap-2 px-3 py-2 border-b border-amber-300 bg-amber-50 text-xs text-amber-900 shrink-0">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-700" />
              <div className="flex-1">
                <div className="font-medium">GitHub authentication required</div>
                <div className="text-[11px] mt-0.5 text-amber-800">
                  {message || "Your GitHub token has expired or been revoked."}
                </div>
                {connectError && <div className="text-[11px] mt-1 text-red-700">{connectError}</div>}
              </div>
              <button
                type="button"
                onClick={handleReconnect}
                className="shrink-0 text-[11px] px-2 py-1 rounded border border-amber-400 bg-amber-100 hover:bg-amber-200 flex items-center gap-1"
              >
                <RefreshCw className="w-3 h-3" /> Reconnect
              </button>
            </div>
          )}
        </>
      )}

      <DeviceFlowDialog
        isOpen={auth.deviceFlow.phase !== "idle"}
        phase={auth.deviceFlow.phase}
        session={auth.deviceFlow.session}
        status={auth.deviceFlow.status}
        errorMessage={auth.deviceFlow.errorMessage}
        onClose={auth.resetDeviceFlow}
        onCancel={auth.cancelFlow}
        onRetry={async () => {
          await auth.startManagedFlow("github");
        }}
      />
    </>
  );
}

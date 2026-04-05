"use client";

/** Threshold (ms) after which connected-but-no-data is considered stale. */
const STALE_THRESHOLD_MS = 30_000;

interface ConnectionBarProps {
  status: "connected" | "reconnecting" | "disconnected";
  lastDataAt?: number;
}

export function ConnectionBar({ status, lastDataAt }: ConnectionBarProps) {
  if (status === "connected") {
    if (lastDataAt !== undefined && Date.now() - lastDataAt > STALE_THRESHOLD_MS) {
      return (
        <div
          className="connection-bar connection-bar--reconnecting"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          Data may be outdated — waiting for server
        </div>
      );
    }
    return null;
  }

  if (status === "disconnected") {
    return (
      <button
        type="button"
        className="connection-bar connection-bar--disconnected"
        aria-live="assertive"
        aria-atomic="true"
        onClick={() => window.location.reload()}
      >
        Offline · tap to retry
      </button>
    );
  }

  return (
    <div
      className="connection-bar connection-bar--reconnecting"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      Reconnecting…
    </div>
  );
}

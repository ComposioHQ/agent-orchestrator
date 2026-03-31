"use client";

interface ConnectionBarProps {
  status: "connected" | "reconnecting" | "disconnected";
}

export function ConnectionBar({ status }: ConnectionBarProps) {
  if (status === "connected") return null;

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

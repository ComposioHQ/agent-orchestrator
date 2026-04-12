"use client";

import { useState, useCallback } from "react";

interface StopAllButtonProps {
  sessionCount: number;
  onComplete?: () => void;
}

export function StopAllButton({ sessionCount, onComplete }: StopAllButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleClick = useCallback(async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/sessions/kill-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error("Kill all failed:", data.error ?? res.statusText);
      }
      onComplete?.();
    } catch (err) {
      console.error("Kill all failed:", err);
    } finally {
      setLoading(false);
      setConfirming(false);
    }
  }, [confirming, onComplete]);

  const handleCancel = useCallback(() => {
    setConfirming(false);
  }, []);

  if (sessionCount === 0) return null;

  return (
    <div className="stop-all-btn-wrapper">
      {confirming ? (
        <>
          <button
            className="stop-all-btn stop-all-btn--confirm"
            onClick={handleClick}
            disabled={loading}
          >
            {loading ? "Stopping\u2026" : `Stop all ${sessionCount}`}
          </button>
          <button
            className="stop-all-btn stop-all-btn--cancel"
            onClick={handleCancel}
            disabled={loading}
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          className="stop-all-btn"
          onClick={handleClick}
        >
          Stop All
        </button>
      )}
    </div>
  );
}

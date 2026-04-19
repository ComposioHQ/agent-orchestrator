"use client";

import { useCallback, useState } from "react";
import { useToast } from "./Toast";

interface CopyDebugBundleButtonProps {
  /** Currently selected project filter, if any (from dashboard URL). */
  projectId?: string;
}

/**
 * Copies observability snapshot + page context to the clipboard for GitHub issues / support.
 */
export function CopyDebugBundleButton({ projectId }: CopyDebugBundleButtonProps) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  const handleClick = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/observability", { credentials: "same-origin" });
      const correlationId = res.headers.get("x-correlation-id");
      let observability: unknown;
      try {
        observability = res.ok
          ? await res.json()
          : { error: `HTTP ${res.status}`, body: await res.text() };
      } catch {
        observability = { error: "Failed to parse observability JSON" };
      }

      const bundle = {
        copiedAt: new Date().toISOString(),
        pageHref: window.location.href,
        projectId: projectId ?? null,
        correlationId,
        userAgent: navigator.userAgent,
        observability,
      };

      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
      showToast("Debug bundle copied to clipboard", "success");
    } catch {
      showToast("Could not copy debug bundle", "error");
    } finally {
      setBusy(false);
    }
  }, [busy, projectId, showToast]);

  return (
    <button
      type="button"
      className="orchestrator-btn flex min-h-[44px] min-w-[44px] items-center gap-2 px-4 py-2 text-[12px] font-semibold text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
      onClick={() => void handleClick()}
      disabled={busy}
      aria-label="Copy debug bundle for issue reports"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      Copy debug info
    </button>
  );
}

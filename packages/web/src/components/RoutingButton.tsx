"use client";

import { useRef, useState } from "react";
import { RoutingPanel } from "./RoutingPanel";

export function RoutingButton() {
  const [showPanel, setShowPanel] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setShowPanel((v) => !v)}
        className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-[11px] transition-colors ${
          showPanel
            ? "border-[var(--color-accent)] text-[var(--color-accent)]"
            : "border-[var(--color-border-subtle)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-default)] hover:text-[var(--color-text-primary)]"
        }`}
        aria-label="LLM Routing settings"
        title="LLM Routing"
      >
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
        </svg>
        <span>Routing</span>
      </button>
      {showPanel && (
        <RoutingPanel onClose={() => setShowPanel(false)} triggerRef={buttonRef} />
      )}
    </div>
  );
}

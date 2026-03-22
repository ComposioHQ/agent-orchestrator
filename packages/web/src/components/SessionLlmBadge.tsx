"use client";

import { useRef, useState } from "react";

interface SessionLlmBadgeProps {
  sessionId: string;
  agentName: string | undefined;
}

const SWITCH_OPTIONS = [
  { value: "claude-code" as const, label: "Switch to Claude" },
  { value: "local-llm" as const, label: "Switch to Local LLM" },
] as const;

function agentLabel(agentName: string | undefined): string {
  if (agentName === "local-llm") return "Local LLM";
  return "Claude";
}

export function SessionLlmBadge({ sessionId, agentName }: SessionLlmBadgeProps) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);

  const displayLabel = agentLabel(agentName);

  const handleSelect = async (nextAgent: "claude-code" | "local-llm") => {
    const currentAgent = agentName ?? "claude-code";
    if (nextAgent === currentAgent) {
      setOpen(false);
      return;
    }
    setOpen(false);
    setSwitching(true);
    setSwitchError("");
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llmOverride: nextAgent }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      // Success — old session will disappear via SSE, new session will appear
    } catch (err) {
      setSwitchError(err instanceof Error ? err.message : "Switch failed");
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={(e) => {
          e.stopPropagation();
          if (!switching) setOpen((v) => !v);
        }}
        disabled={switching}
        className="flex items-center gap-1 rounded border border-[rgba(125,133,144,0.4)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[rgba(125,133,144,0.8)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
        title={`Using ${displayLabel}`}
      >
        <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
        </svg>
        {switching ? "Switching…" : displayLabel}
      </button>

      {switchError && (
        <p className="absolute left-0 top-full mt-0.5 max-w-[200px] text-[10px] text-[var(--color-status-error)]">
          {switchError}
        </p>
      )}

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-[160px] rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] py-1 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="px-2.5 pb-1 pt-0.5 text-[9px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
            Switch LLM
          </p>
          {SWITCH_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => void handleSelect(opt.value)}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[10px] transition-colors hover:bg-[var(--color-bg-hover)] ${
                (agentName ?? "claude-code") === opt.value
                  ? "text-[var(--color-accent)]"
                  : "text-[var(--color-text-secondary)]"
              }`}
            >
              {(agentName ?? "claude-code") === opt.value && (
                <svg className="h-2.5 w-2.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              )}
              {(agentName ?? "claude-code") !== opt.value && <span className="h-2.5 w-2.5 shrink-0" />}
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

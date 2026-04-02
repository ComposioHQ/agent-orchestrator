"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";

interface NewTerminalModalProps {
  open: boolean;
  onClose: () => void;
}

export function NewTerminalModal({ open, onClose }: NewTerminalModalProps) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Fetch tmux sessions for auto-complete
  const fetchSuggestions = useCallback(async () => {
    try {
      const res = await fetch("/api/tmux-sessions");
      if (!res.ok) throw new Error("Failed to fetch sessions");
      const data = (await res.json()) as { sessions: string[] };
      setSuggestions(data.sessions ?? []);
    } catch (err) {
      console.error("Failed to fetch suggestions:", err);
      setSuggestions([]);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setInput("");
      setError(null);
      setShowSuggestions(true);
      void fetchSuggestions();
      // Focus input after modal opens
      const t = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(t);
    }
  }, [open, fetchSuggestions]);

  const filteredSuggestions = input.trim()
    ? suggestions.filter((s) => s.toLowerCase().includes(input.toLowerCase()))
    : suggestions;

  const handleCreate = async (tmuxName: string) => {
    if (!tmuxName.trim()) {
      setError("Session name is required");
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const res = await fetch("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmuxName: tmuxName.trim() }),
      });

      if (!res.ok) {
        const errData = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errData?.error ?? `HTTP ${res.status}`);
      }

      const data = (await res.json()) as { terminal: { tmuxName: string } };
      onClose();
      router.push(`/terminals/${encodeURIComponent(data.terminal.tmuxName)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create terminal";
      setError(msg);
    } finally {
      setCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleCreate(input);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-sm rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-3">
          <h2 className="text-sm font-semibold">New Terminal</h2>
          <button
            onClick={onClose}
            className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            ✕
          </button>
        </div>

        <div className="p-4">
          <div className="mb-2">
            <label className="text-xs font-medium text-[var(--color-text-secondary)]">
              tmux session name
            </label>
          </div>

          <div className="relative">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setShowSuggestions(true);
              }}
              onKeyDown={handleKeyDown}
              onFocus={() => setShowSuggestions(true)}
              placeholder="e.g., my-logs, dev-server"
              className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent)]"
            />

            {/* Auto-complete dropdown */}
            {showSuggestions && filteredSuggestions.length > 0 && (
              <div
                ref={suggestionsRef}
                className="absolute top-full z-10 mt-1 w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] shadow-lg"
              >
                {filteredSuggestions.slice(0, 8).map((session) => (
                  <button
                    key={session}
                    type="button"
                    onClick={() => void handleCreate(session)}
                    className="block w-full text-left px-3 py-2 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-bg-subtle)]"
                  >
                    {session}
                  </button>
                ))}
              </div>
            )}
          </div>

          {error && <div className="mt-2 text-xs text-[var(--color-status-error)]">{error}</div>}

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded border border-[var(--color-border-default)] px-3 py-2 text-sm font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-subtle)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleCreate(input)}
              disabled={creating || !input.trim()}
              className={cn(
                "flex-1 rounded px-3 py-2 text-sm font-medium text-white transition-colors",
                creating || !input.trim()
                  ? "cursor-not-allowed bg-[var(--color-accent)]/50"
                  : "bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]"
              )}
            >
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

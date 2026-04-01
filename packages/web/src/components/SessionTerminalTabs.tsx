"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { DirectTerminal } from "@/components/DirectTerminal";
import {
  loadSessionTerminalTabState,
  saveSessionTerminalTabState,
} from "@/components/workspace/sessionTerminalTabState";

interface SubSessionJson {
  id: string;
  parentId: string;
  type: "primary" | "terminal";
  tmuxName: string;
  workspacePath: string;
  alive: boolean;
}

function tabLabel(sub: SubSessionJson): string {
  if (sub.type === "primary") return "Agent";
  const m = sub.id.match(/-t(\d+)$/);
  return m ? `T${m[1]}` : sub.id;
}

interface SessionTerminalTabsProps {
  sessionId: string;
  variant?: "agent" | "orchestrator";
  isOpenCodeSession?: boolean;
  reloadCommand?: string;
}

export function SessionTerminalTabs({
  sessionId,
  variant = "agent",
  isOpenCodeSession = false,
  reloadCommand,
}: SessionTerminalTabsProps) {
  const [subs, setSubs] = useState<SubSessionJson[] | null>(null);
  const [activeId, setActiveId] = useState(sessionId);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const lastInitSessionRef = useRef<string | null>(null);

  const loadSubs = useCallback(async (): Promise<SubSessionJson[] | null> => {
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/sub-sessions`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { subSessions?: SubSessionJson[] };
      const list = data.subSessions ?? [];
      setSubs(list);
      return list;
    } catch (e) {
      setSubs([]);
      setError(e instanceof Error ? e.message : "Failed to load terminals");
      return null;
    }
  }, [sessionId]);

  // Reset when navigating to another AO session
  useEffect(() => {
    lastInitSessionRef.current = null;
    setSubs(null);
    setActiveId(sessionId);
  }, [sessionId]);

  // Initial fetch + apply sessionStorage preference (same pattern as sessionFileState)
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (lastInitSessionRef.current === sessionId) return;

      // Load stored state synchronously before fetching (optimization)
      const stored = loadSessionTerminalTabState(sessionId);

      const list = await loadSubs();
      if (cancelled || !list?.length) return;

      lastInitSessionRef.current = sessionId;

      let nextId = sessionId; // default to primary

      // Check if stored sub-session is still available
      if (stored?.subSessionId) {
        const match = list.find((s) => s.id === stored.subSessionId);
        if (match) {
          if (match.type === "terminal" && !match.alive) {
            // Terminal sub-session is dead, attempt to restore it
            try {
              const res = await fetch(
                `/api/sessions/${encodeURIComponent(sessionId)}/sub-sessions/${encodeURIComponent(match.id)}/restore`,
                { method: "POST" },
              );
              if (res.ok) {
                // Restore succeeded, use this sub-session
                nextId = stored.subSessionId;
              }
              // If restore fails, fallback to primary
            } catch {
              // Restore failed, fallback to primary
            }
          } else {
            // Terminal is alive or primary exists, use the stored selection
            nextId = stored.subSessionId;
          }
        }
        // If stored sub-session doesn't exist in list, use primary (nextId stays as sessionId)
      }

      if (!cancelled) {
        setActiveId(nextId);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, loadSubs]);

  // If the active tab disappeared (e.g. sub killed elsewhere), fall back to the first tab
  useEffect(() => {
    if (subs === null || subs.length === 0) return;
    if (!subs.some((s) => s.id === activeId)) {
      setActiveId(subs[0].id);
    }
  }, [subs, activeId]);

  // Persist tab choice (sessionStorage, per parent session — mirrors sessionFileState)
  useEffect(() => {
    if (subs === null) return;
    if (!subs.some((s) => s.id === activeId)) return;
    saveSessionTerminalTabState(sessionId, activeId);
  }, [sessionId, activeId, subs]);


  const selectTab = useCallback(
    async (sub: SubSessionJson) => {
      setError(null);
      if (sub.type === "terminal" && !sub.alive) {
        try {
          const res = await fetch(
            `/api/sessions/${encodeURIComponent(sessionId)}/sub-sessions/${encodeURIComponent(sub.id)}/restore`,
            { method: "POST" },
          );
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new Error(body?.error ?? `HTTP ${res.status}`);
          }
          await loadSubs();
        } catch (e) {
          setError(e instanceof Error ? e.message : "Failed to restore terminal");
          return;
        }
      }
      setActiveId(sub.id);
    },
    [sessionId, loadSubs],
  );

  // Sub-session tab navigation shortcuts — Cmd+Shift+ArrowRight/Left
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.shiftKey)) return;

      if (!subs || subs.length === 0) return;

      const isRight = e.key === "ArrowRight";
      const isLeft = e.key === "ArrowLeft";

      if (!isRight && !isLeft) return;

      const currentIdx = subs.findIndex((s) => s.id === activeId);
      if (currentIdx === -1) return;

      e.preventDefault();

      let nextIdx: number;
      if (isRight) {
        nextIdx = (currentIdx + 1) % subs.length;
      } else {
        nextIdx = (currentIdx - 1 + subs.length) % subs.length;
      }

      const nextSub = subs[nextIdx];
      if (nextSub) {
        void selectTab(nextSub);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [subs, activeId, selectTab]);

  const addTerminal = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/sub-sessions`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { subSession?: SubSessionJson };
      await loadSubs();
      if (data.subSession?.id) {
        setActiveId(data.subSession.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create terminal");
    } finally {
      setCreating(false);
    }
  }, [sessionId, loadSubs]);

  const rows = subs ?? [];
  const active = rows.find((s) => s.id === activeId) ?? rows[0];
  const terminalTarget = active?.id ?? sessionId;
  const showOpenCodeTools = active?.type === "primary" && isOpenCodeSession;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-2 py-1.5">
        <button
          type="button"
          title="New terminal in this worktree"
          disabled={creating || subs === null}
          onClick={() => void addTerminal()}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded border text-sm font-medium transition-colors",
            creating || subs === null
              ? "cursor-not-allowed border-[var(--color-border-muted)] text-[var(--color-text-tertiary)]"
              : "cursor-pointer border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)]",
          )}
        >
          +
        </button>
        {rows.map((sub) => (
          <button
            key={sub.id}
            type="button"
            title={sub.tmuxName}
            onClick={() => void selectTab(sub)}
            className={cn(
              "cursor-pointer rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
              sub.id === activeId
                ? "bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] shadow-sm"
                : "text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-secondary)]",
              sub.type === "terminal" && !sub.alive && sub.id !== activeId
                ? "opacity-60"
                : "",
            )}
          >
            {tabLabel(sub)}
          </button>
        ))}
        {error ? (
          <span className="ml-2 max-w-[min(280px,40vw)] truncate text-[10px] text-[var(--color-status-error)]">
            {error}
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <DirectTerminal
          key={terminalTarget}
          sessionId={terminalTarget}
          variant={variant}
          height="100%"
          headerLabel="Terminal"
          isOpenCodeSession={showOpenCodeTools}
          reloadCommand={showOpenCodeTools ? reloadCommand : undefined}
          autoFocus={true}
        />
      </div>
    </div>
  );
}

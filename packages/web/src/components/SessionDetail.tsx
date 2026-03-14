"use client";

import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { type DashboardSession, type DashboardPR } from "@/lib/types";
import { cn } from "@/lib/cn";
import { DirectTerminal } from "./DirectTerminal";
import {
  cleanBugbotComment,
  PRInspectionSummary,
  SessionInspectionSummary,
} from "./session-inspection";

interface OrchestratorZones {
  merge: number;
  respond: number;
  review: number;
  pending: number;
  working: number;
  done: number;
}

interface SessionDetailProps {
  session: DashboardSession;
  isOrchestrator?: boolean;
  orchestratorZones?: OrchestratorZones;
}

async function askAgentToFix(
  sessionId: string,
  comment: { url: string; path: string; body: string },
  onSuccess: () => void,
  onError: () => void,
) {
  try {
    const { title, description } = cleanBugbotComment(comment.body);
    const message = `Please address this review comment:\n\nFile: ${comment.path}\nComment: ${title}\nDescription: ${description}\n\nComment URL: ${comment.url}\n\nAfter fixing, mark the comment as resolved at ${comment.url}`;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    onSuccess();
  } catch (err) {
    console.error("Failed to send message to agent:", err);
    onError();
  }
}

// ── Orchestrator status strip ─────────────────────────────────────────

function OrchestratorStatusStrip({
  zones,
  createdAt,
}: {
  zones: OrchestratorZones;
  createdAt: string;
}) {
  const [uptime, setUptime] = useState<string>("");

  useEffect(() => {
    const compute = () => {
      const diff = Date.now() - new Date(createdAt).getTime();
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      setUptime(h > 0 ? `${h}h ${m}m` : `${m}m`);
    };
    compute();
    const id = setInterval(compute, 30_000);
    return () => clearInterval(id);
  }, [createdAt]);

  const stats: Array<{ value: number; label: string; color: string; bg: string }> = [
    { value: zones.merge, label: "merge-ready", color: "#3fb950", bg: "rgba(63,185,80,0.1)" },
    { value: zones.respond, label: "responding", color: "#f85149", bg: "rgba(248,81,73,0.1)" },
    { value: zones.review, label: "review", color: "#d18616", bg: "rgba(209,134,22,0.1)" },
    { value: zones.working, label: "working", color: "#58a6ff", bg: "rgba(88,166,255,0.1)" },
    { value: zones.pending, label: "pending", color: "#d29922", bg: "rgba(210,153,34,0.1)" },
    { value: zones.done, label: "done", color: "#484f58", bg: "rgba(72,79,88,0.15)" },
  ].filter((s) => s.value > 0);

  const total =
    zones.merge + zones.respond + zones.review + zones.working + zones.pending + zones.done;

  return (
    <div
      className="border-b border-[var(--color-border-subtle)] px-8 py-4"
      style={{
        background: "linear-gradient(to bottom, rgba(88,166,255,0.04) 0%, transparent 100%)",
      }}
    >
      <div className="mx-auto flex max-w-[900px] items-center gap-3 flex-wrap">
        {/* Total count */}
        <div className="flex items-baseline gap-1.5 mr-2">
          <span className="text-[22px] font-bold leading-none tabular-nums text-[var(--color-text-primary)]">
            {total}
          </span>
          <span className="text-[11px] text-[var(--color-text-tertiary)]">agents</span>
        </div>

        <div className="h-5 w-px bg-[var(--color-border-subtle)] mr-1" />

        {/* Per-zone pills */}
        {stats.length > 0 ? (
          stats.map((s) => (
            <div
              key={s.label}
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1"
              style={{ background: s.bg }}
            >
              <span
                className="text-[15px] font-bold leading-none tabular-nums"
                style={{ color: s.color }}
              >
                {s.value}
              </span>
              <span className="text-[10px] font-medium" style={{ color: s.color, opacity: 0.8 }}>
                {s.label}
              </span>
            </div>
          ))
        ) : (
          <span className="text-[12px] text-[var(--color-text-tertiary)]">no active agents</span>
        )}

        {uptime && (
          <span className="ml-auto font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)]">
            up {uptime}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────

export function SessionDetail({
  session,
  isOrchestrator = false,
  orchestratorZones,
}: SessionDetailProps) {
  const searchParams = useSearchParams();
  const startFullscreen = searchParams.get("fullscreen") === "true";
  const pr = session.pr;

  const accentColor = "var(--color-accent)";
  const terminalVariant = isOrchestrator ? "orchestrator" : "agent";

  const terminalHeight = isOrchestrator ? "calc(100vh - 240px)" : "max(440px, calc(100vh - 440px))";
  const isOpenCodeSession = session.metadata["agent"] === "opencode";
  const opencodeSessionId =
    typeof session.metadata["opencodeSessionId"] === "string" &&
    session.metadata["opencodeSessionId"].length > 0
      ? session.metadata["opencodeSessionId"]
      : undefined;
  const reloadCommand = opencodeSessionId
    ? `/exit\nopencode --session ${opencodeSessionId}\n`
    : undefined;

  return (
    <div className="min-h-screen bg-[var(--color-bg-base)]">
      {/* Nav bar — glass effect */}
      <nav className="nav-glass sticky top-0 z-10 border-b border-[var(--color-border-subtle)]">
        <div className="mx-auto flex max-w-[900px] items-center gap-2 px-8 py-2.5">
          <a
            href="/"
            className="flex items-center gap-1 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] hover:no-underline"
          >
            <svg
              className="h-3 w-3 opacity-60"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
            Orchestrator
          </a>
          <span className="text-[var(--color-border-strong)]">/</span>
          <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)]">
            {session.id}
          </span>
          {isOrchestrator && (
            <span
              className="ml-1 rounded px-2 py-0.5 text-[10px] font-semibold tracking-[0.05em]"
              style={{
                color: accentColor,
                background: `color-mix(in srgb, ${accentColor} 10%, transparent)`,
                border: `1px solid color-mix(in srgb, ${accentColor} 20%, transparent)`,
              }}
            >
              orchestrator
            </span>
          )}
        </div>
      </nav>

      {/* Orchestrator status strip */}
      {isOrchestrator && orchestratorZones && (
        <OrchestratorStatusStrip zones={orchestratorZones} createdAt={session.createdAt} />
      )}

      <div className="mx-auto max-w-[900px] px-8 py-6">
        {/* ── Header card ─────────────────────────────────────────── */}
        <div
          className="detail-card mb-6 rounded-[8px] border border-[var(--color-border-default)] p-5"
          style={{
            borderLeft: isOrchestrator ? `3px solid ${accentColor}` : undefined,
          }}
        >
          <SessionInspectionSummary session={session} />
        </div>

        {/* ── PR Card ─────────────────────────────────────────────── */}
        {pr && <PRCard pr={pr} sessionId={session.id} />}

        {/* ── Terminal ─────────────────────────────────────────────── */}
        <div className={pr ? "mt-6" : ""}>
          <div className="mb-3 flex items-center gap-2">
            <div
              className="h-3 w-0.5 rounded-full"
              style={{ background: accentColor, opacity: 0.7 }}
            />
            <span className="text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
              Terminal
            </span>
          </div>
          <DirectTerminal
            sessionId={session.id}
            startFullscreen={startFullscreen}
            variant={terminalVariant}
            height={terminalHeight}
            isOpenCodeSession={isOpenCodeSession}
            reloadCommand={isOpenCodeSession ? reloadCommand : undefined}
          />
        </div>
      </div>
    </div>
  );
}

// ── PR Card ───────────────────────────────────────────────────────────

function PRCard({ pr, sessionId }: { pr: DashboardPR; sessionId: string }) {
  const [sendingComments, setSendingComments] = useState<Set<string>>(new Set());
  const [sentComments, setSentComments] = useState<Set<string>>(new Set());
  const [errorComments, setErrorComments] = useState<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  const handleAskAgentToFix = async (comment: { url: string; path: string; body: string }) => {
    setSentComments((prev) => {
      const next = new Set(prev);
      next.delete(comment.url);
      return next;
    });
    setErrorComments((prev) => {
      const next = new Set(prev);
      next.delete(comment.url);
      return next;
    });
    setSendingComments((prev) => new Set(prev).add(comment.url));

    await askAgentToFix(
      sessionId,
      comment,
      () => {
        setSendingComments((prev) => {
          const next = new Set(prev);
          next.delete(comment.url);
          return next;
        });
        setSentComments((prev) => new Set(prev).add(comment.url));
        const existing = timersRef.current.get(comment.url);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          setSentComments((prev) => {
            const next = new Set(prev);
            next.delete(comment.url);
            return next;
          });
          timersRef.current.delete(comment.url);
        }, 3000);
        timersRef.current.set(comment.url, timer);
      },
      () => {
        setSendingComments((prev) => {
          const next = new Set(prev);
          next.delete(comment.url);
          return next;
        });
        setErrorComments((prev) => new Set(prev).add(comment.url));
        const existing = timersRef.current.get(comment.url);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          setErrorComments((prev) => {
            const next = new Set(prev);
            next.delete(comment.url);
            return next;
          });
          timersRef.current.delete(comment.url);
        }, 3000);
        timersRef.current.set(comment.url, timer);
      },
    );
  };

  return (
    <div className="detail-card mb-6 space-y-4">
      <PRInspectionSummary pr={pr} />
      {pr.unresolvedComments.length > 0 && (
        <div className="overflow-hidden rounded-[8px] border border-[var(--color-border-default)] px-5 py-4">
            <h4 className="mb-2.5 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
              Unresolved Comments
              <span
                className="rounded-full px-1.5 py-0.5 text-[10px] font-bold normal-case tracking-normal"
                style={{ color: "#f85149", background: "rgba(248,81,73,0.12)" }}
              >
                {pr.unresolvedThreads}
              </span>
            </h4>
            <div className="space-y-1">
              {pr.unresolvedComments.map((c) => {
                const { title, description } = cleanBugbotComment(c.body);
                return (
                  <details key={c.url} className="group">
                    <summary className="flex cursor-pointer list-none items-center gap-2 rounded-[5px] px-2 py-1.5 text-[12px] transition-colors hover:bg-[rgba(255,255,255,0.04)]">
                      <svg
                        className="h-3 w-3 shrink-0 text-[var(--color-text-tertiary)] transition-transform group-open:rotate-90"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        viewBox="0 0 24 24"
                      >
                        <path d="M9 5l7 7-7 7" />
                      </svg>
                      <span className="font-medium text-[var(--color-text-secondary)]">
                        {title}
                      </span>
                      <span className="text-[var(--color-text-tertiary)]">· {c.author}</span>
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="ml-auto text-[10px] text-[var(--color-accent)] hover:underline"
                      >
                        view →
                      </a>
                    </summary>
                    <div className="ml-5 mt-1 space-y-1.5 px-2 pb-2">
                      <div className="font-[var(--font-mono)] text-[10px] text-[var(--color-text-tertiary)]">
                        {c.path}
                      </div>
                      <p className="border-l-2 border-[var(--color-border-default)] pl-3 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
                        {description}
                      </p>
                      <button
                        onClick={() => handleAskAgentToFix(c)}
                        disabled={sendingComments.has(c.url)}
                        className={cn(
                          "mt-1.5 rounded-[4px] px-3 py-1 text-[11px] font-semibold transition-all",
                          sentComments.has(c.url)
                            ? "bg-[var(--color-status-ready)] text-white"
                            : errorComments.has(c.url)
                              ? "bg-[var(--color-status-error)] text-white"
                              : "bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50",
                        )}
                      >
                        {sendingComments.has(c.url)
                          ? "Sending…"
                          : sentComments.has(c.url)
                            ? "Sent ✓"
                            : errorComments.has(c.url)
                              ? "Failed"
                              : "Ask Agent to Fix"}
                      </button>
                    </div>
                  </details>
                );
              })}
            </div>
        </div>
      )}
    </div>
  );
}

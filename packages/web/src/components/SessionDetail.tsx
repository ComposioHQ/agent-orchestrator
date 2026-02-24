"use client";

import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { type DashboardSession, type DashboardPR } from "@/lib/types";
import { CI_STATUS } from "@composio/ao-core/types";
import { cn } from "@/lib/cn";
import { CICheckList } from "./CIBadge";
import { DirectTerminal } from "./DirectTerminal";
import { ActivityDot } from "./ActivityDot";

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

// ── Helpers ──────────────────────────────────────────────────────────

const activityMeta: Record<string, { label: string; color: string }> = {
  active:        { label: "Active",            color: "var(--color-status-working)" },
  ready:         { label: "Ready",             color: "var(--color-status-ready)" },
  idle:          { label: "Idle",              color: "var(--color-status-idle)" },
  waiting_input: { label: "Waiting for input", color: "var(--color-status-attention)" },
  blocked:       { label: "Blocked",           color: "var(--color-status-error)" },
  exited:        { label: "Exited",            color: "var(--color-status-error)" },
};

function humanizeStatus(status: string): string {
  return status
    .replace(/_/g, " ")
    .replace(/\bci\b/gi, "CI")
    .replace(/\bpr\b/gi, "PR")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function relativeTime(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!iso || isNaN(ms)) return "unknown";
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function cleanBugbotComment(body: string): { title: string; description: string } {
  const isBugbot = body.includes("<!-- DESCRIPTION START -->") || body.includes("### ");
  if (isBugbot) {
    const titleMatch = body.match(/###\s+(.+?)(?:\n|$)/);
    const title = titleMatch ? titleMatch[1].replace(/\*\*/g, "").trim() : "Comment";
    const descMatch = body.match(
      /<!-- DESCRIPTION START -->\s*([\s\S]*?)\s*<!-- DESCRIPTION END -->/,
    );
    const description = descMatch ? descMatch[1].trim() : body.split("\n")[0] || "No description";
    return { title, description };
  }
  return { title: "Comment", description: body.trim() };
}

function buildGitHubBranchUrl(pr: DashboardPR): string {
  return `https://github.com/${pr.owner}/${pr.repo}/tree/${pr.branch}`;
}

function buildGitHubRepoUrl(pr: DashboardPR): string {
  return `https://github.com/${pr.owner}/${pr.repo}`;
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
    { value: zones.merge,   label: "merge-ready",  color: "#3fb950", bg: "rgba(63,185,80,0.1)" },
    { value: zones.respond, label: "responding",   color: "#f85149", bg: "rgba(248,81,73,0.1)" },
    { value: zones.review,  label: "review",       color: "#d18616", bg: "rgba(209,134,22,0.1)" },
    { value: zones.working, label: "working",      color: "#58a6ff", bg: "rgba(88,166,255,0.1)" },
    { value: zones.pending, label: "pending",      color: "#d29922", bg: "rgba(210,153,34,0.1)" },
    { value: zones.done,    label: "done",         color: "#484f58", bg: "rgba(72,79,88,0.15)" },
  ].filter((s) => s.value > 0);

  const total = zones.merge + zones.respond + zones.review + zones.working + zones.pending + zones.done;

  return (
    <div
      className="border-b border-[var(--color-border-subtle)] px-4 py-3 md:px-8 md:py-4"
      style={{ background: "linear-gradient(to bottom, rgba(88,166,255,0.04) 0%, transparent 100%)" }}
    >
      <div className="mx-auto flex max-w-[900px] items-center gap-2 flex-wrap md:gap-3">
        {/* Total count */}
        <div className="flex items-baseline gap-1.5 mr-2">
          <span className="text-[22px] font-bold leading-none tabular-nums text-[var(--color-text-primary)]">
            {total}
          </span>
          <span className="text-[11px] text-[var(--color-text-tertiary)]">agents</span>
        </div>

        <div className="h-5 w-px bg-[var(--color-border-subtle)] mr-1" />

        {/* Per-zone pills */}
        {stats.length > 0 ? stats.map((s) => (
          <div
            key={s.label}
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1"
            style={{ background: s.bg }}
          >
            <span className="text-[15px] font-bold leading-none tabular-nums" style={{ color: s.color }}>
              {s.value}
            </span>
            <span className="text-[10px] font-medium" style={{ color: s.color, opacity: 0.8 }}>
              {s.label}
            </span>
          </div>
        )) : (
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

export function SessionDetail({ session, isOrchestrator = false, orchestratorZones }: SessionDetailProps) {
  const searchParams = useSearchParams();
  const startFullscreen = searchParams.get("fullscreen") === "true";
  const pr = session.pr;
  const activity = (session.activity && activityMeta[session.activity]) ?? {
    label: session.activity ?? "unknown",
    color: "var(--color-text-muted)",
  };

  const accentColor = "var(--color-accent)";
  const terminalVariant = isOrchestrator ? "orchestrator" : "agent";

  const terminalHeight = isOrchestrator
    ? "calc(100vh - 240px)"
    : "max(300px, calc(100vh - 380px))";

  return (
    <div className="min-h-screen bg-[var(--color-bg-base)]">
      {/* Nav bar — glass effect */}
      <nav className="nav-glass sticky top-0 z-10 border-b border-[var(--color-border-subtle)]">
        <div className="mx-auto flex max-w-[900px] items-center gap-2 px-4 py-2.5 md:px-8">
          <a
            href="/"
            className="flex items-center gap-1 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] hover:no-underline"
          >
            <svg className="h-3 w-3 opacity-60" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
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

      <div className="mx-auto max-w-[900px] px-4 py-4 md:px-8 md:py-6">
        {/* ── Header card ─────────────────────────────────────────── */}
        <div
          className="detail-card mb-4 rounded-[8px] border border-[var(--color-border-default)] p-3.5 md:mb-6 md:p-5"
          style={{
            borderLeft: isOrchestrator
              ? `3px solid ${accentColor}`
              : `3px solid ${activity.color}`,
          }}
        >
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="break-all font-[var(--font-mono)] text-[14px] font-semibold tracking-[-0.01em] text-[var(--color-text-primary)] md:text-[17px]">
                  {session.id}
                </h1>
                {/* Activity badge */}
                <div
                  className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5"
                  style={{
                    background: `color-mix(in srgb, ${activity.color} 12%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${activity.color} 20%, transparent)`,
                  }}
                >
                  <ActivityDot activity={session.activity} dotOnly size={6} />
                  <span className="text-[11px] font-semibold" style={{ color: activity.color }}>
                    {activity.label}
                  </span>
                </div>
              </div>

              {session.summary && (
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
                  {session.summary}
                </p>
              )}

              {/* Meta chips */}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {session.projectId && (
                  <>
                    {pr ? (
                      <a
                        href={buildGitHubRepoUrl(pr)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-[4px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)] hover:no-underline"
                      >
                        {session.projectId}
                      </a>
                    ) : (
                      <span className="rounded-[4px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
                        {session.projectId}
                      </span>
                    )}
                    <span className="text-[var(--color-text-tertiary)]">&middot;</span>
                  </>
                )}

                {pr && (
                  <>
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-[4px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-2 py-0.5 text-[11px] text-[var(--color-accent)] transition-colors hover:border-[var(--color-accent)] hover:no-underline"
                    >
                      PR #{pr.number}
                    </a>
                    {(session.branch || session.issueUrl) && (
                      <span className="text-[var(--color-text-tertiary)]">&middot;</span>
                    )}
                  </>
                )}

                {session.branch && (
                  <>
                    {pr ? (
                      <a
                        href={buildGitHubBranchUrl(pr)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-[4px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-2 py-0.5 font-[var(--font-mono)] text-[10px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)] hover:no-underline"
                      >
                        {session.branch}
                      </a>
                    ) : (
                      <span className="rounded-[4px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-2 py-0.5 font-[var(--font-mono)] text-[10px] text-[var(--color-text-secondary)]">
                        {session.branch}
                      </span>
                    )}
                    {session.issueUrl && (
                      <span className="text-[var(--color-text-tertiary)]">&middot;</span>
                    )}
                  </>
                )}

                {session.issueUrl && (
                  <a
                    href={session.issueUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-[4px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)] hover:no-underline"
                  >
                    {session.issueLabel || session.issueUrl}
                  </a>
                )}
              </div>

              <ClientTimestamps
                status={session.status}
                createdAt={session.createdAt}
                lastActivityAt={session.lastActivityAt}
              />
            </div>
          </div>
        </div>

        {/* ── PR Card ─────────────────────────────────────────────── */}
        {pr && <PRCard pr={pr} sessionId={session.id} />}

        {/* ── Terminal ─────────────────────────────────────────────── */}
        <div className={pr ? "mt-6" : ""}>
          <div className="mb-3 flex items-center gap-2">
            <div
              className="h-3 w-0.5 rounded-full"
              style={{ background: isOrchestrator ? accentColor : activity.color, opacity: 0.7 }}
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
          />
        </div>
      </div>
    </div>
  );
}

// ── Client-side timestamps ────────────────────────────────────────────

function ClientTimestamps({
  status,
  createdAt,
  lastActivityAt,
}: {
  status: string;
  createdAt: string;
  lastActivityAt: string;
}) {
  const [created, setCreated] = useState<string | null>(null);
  const [lastActive, setLastActive] = useState<string | null>(null);

  useEffect(() => {
    setCreated(relativeTime(createdAt));
    setLastActive(relativeTime(lastActivityAt));
  }, [createdAt, lastActivityAt]);

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-[var(--color-text-tertiary)]">
      <span className="rounded-[3px] bg-[rgba(255,255,255,0.05)] px-1.5 py-0.5 text-[10px] font-medium">
        {humanizeStatus(status)}
      </span>
      {created && (
        <>
          <span className="opacity-40">&middot;</span>
          <span>created {created}</span>
        </>
      )}
      {lastActive && (
        <>
          <span className="opacity-40">&middot;</span>
          <span>active {lastActive}</span>
        </>
      )}
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
    setSentComments((prev) => { const next = new Set(prev); next.delete(comment.url); return next; });
    setErrorComments((prev) => { const next = new Set(prev); next.delete(comment.url); return next; });
    setSendingComments((prev) => new Set(prev).add(comment.url));

    await askAgentToFix(
      sessionId,
      comment,
      () => {
        setSendingComments((prev) => { const next = new Set(prev); next.delete(comment.url); return next; });
        setSentComments((prev) => new Set(prev).add(comment.url));
        const existing = timersRef.current.get(comment.url);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          setSentComments((prev) => { const next = new Set(prev); next.delete(comment.url); return next; });
          timersRef.current.delete(comment.url);
        }, 3000);
        timersRef.current.set(comment.url, timer);
      },
      () => {
        setSendingComments((prev) => { const next = new Set(prev); next.delete(comment.url); return next; });
        setErrorComments((prev) => new Set(prev).add(comment.url));
        const existing = timersRef.current.get(comment.url);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          setErrorComments((prev) => { const next = new Set(prev); next.delete(comment.url); return next; });
          timersRef.current.delete(comment.url);
        }, 3000);
        timersRef.current.set(comment.url, timer);
      },
    );
  };

  const allGreen =
    pr.mergeability.mergeable &&
    pr.mergeability.ciPassing &&
    pr.mergeability.approved &&
    pr.mergeability.noConflicts;

  const failedChecks = pr.ciChecks.filter((c) => c.status === "failed");

  const borderColor = allGreen
    ? "rgba(63,185,80,0.4)"
    : pr.state === "merged"
      ? "rgba(163,113,247,0.3)"
      : "var(--color-border-default)";

  return (
    <div
      className="detail-card mb-6 overflow-hidden rounded-[8px] border"
      style={{ borderColor }}
    >
      {/* Title row */}
      <div className="border-b border-[var(--color-border-subtle)] px-3.5 py-3 md:px-5 md:py-3.5">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[13px] font-semibold text-[var(--color-text-primary)] transition-colors hover:text-[var(--color-accent)] hover:no-underline"
        >
          PR #{pr.number}: {pr.title}
        </a>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
          <span>
            <span className="text-[var(--color-status-ready)]">+{pr.additions}</span>{" "}
            <span className="text-[var(--color-status-error)]">-{pr.deletions}</span>
          </span>
          {pr.isDraft && (
            <>
              <span className="text-[var(--color-text-tertiary)]">&middot;</span>
              <span className="font-medium text-[var(--color-text-tertiary)]">Draft</span>
            </>
          )}
          {pr.state === "merged" && (
            <>
              <span className="text-[var(--color-text-tertiary)]">&middot;</span>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                style={{ color: "#a371f7", background: "rgba(163,113,247,0.12)" }}
              >
                Merged
              </span>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-3.5 py-3 md:px-5 md:py-4">
        {/* Ready-to-merge banner */}
        {allGreen ? (
          <div className="flex items-center gap-2 rounded-[5px] border border-[rgba(63,185,80,0.25)] bg-[rgba(63,185,80,0.07)] px-3.5 py-2.5">
            <svg className="h-4 w-4 shrink-0 text-[var(--color-status-ready)]" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            <span className="text-[13px] font-semibold text-[var(--color-status-ready)]">
              Ready to merge
            </span>
          </div>
        ) : (
          <IssuesList pr={pr} />
        )}

        {/* CI Checks */}
        {pr.ciChecks.length > 0 && (
          <div className="mt-4 border-t border-[var(--color-border-subtle)] pt-4">
            <CICheckList checks={pr.ciChecks} layout={failedChecks.length > 0 ? "expanded" : "inline"} />
          </div>
        )}

        {/* Unresolved comments */}
        {pr.unresolvedComments.length > 0 && (
          <div className="mt-4 border-t border-[var(--color-border-subtle)] pt-4">
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
                      <span className="font-medium text-[var(--color-text-secondary)]">{title}</span>
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
                          "mt-1.5 min-h-[44px] rounded-[4px] px-4 py-2 text-[11px] font-semibold transition-all md:min-h-0 md:px-3 md:py-1",
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
    </div>
  );
}

// ── Issues list (pre-merge blockers) ─────────────────────────────────

function IssuesList({ pr }: { pr: DashboardPR }) {
  const issues: Array<{ icon: string; color: string; text: string }> = [];

  if (pr.ciStatus === CI_STATUS.FAILING) {
    const failCount = pr.ciChecks.filter((c) => c.status === "failed").length;
    issues.push({
      icon: "✗",
      color: "var(--color-status-error)",
      text: failCount > 0
        ? `CI failing — ${failCount} check${failCount !== 1 ? "s" : ""} failed`
        : "CI failing",
    });
  } else if (pr.ciStatus === CI_STATUS.PENDING) {
    issues.push({ icon: "●", color: "var(--color-status-attention)", text: "CI pending" });
  }

  if (pr.reviewDecision === "changes_requested") {
    issues.push({ icon: "✗", color: "var(--color-status-error)", text: "Changes requested" });
  } else if (!pr.mergeability.approved) {
    issues.push({ icon: "○", color: "var(--color-text-tertiary)", text: "Not approved — awaiting reviewer" });
  }

  if (pr.state !== "merged" && !pr.mergeability.noConflicts) {
    issues.push({ icon: "✗", color: "var(--color-status-error)", text: "Merge conflicts" });
  }

  if (!pr.mergeability.mergeable && issues.length === 0) {
    issues.push({ icon: "○", color: "var(--color-text-tertiary)", text: "Not mergeable" });
  }

  if (pr.unresolvedThreads > 0) {
    issues.push({
      icon: "●",
      color: "var(--color-status-attention)",
      text: `${pr.unresolvedThreads} unresolved comment${pr.unresolvedThreads !== 1 ? "s" : ""}`,
    });
  }

  if (pr.isDraft) {
    issues.push({ icon: "○", color: "var(--color-text-tertiary)", text: "Draft PR" });
  }

  if (issues.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <h4 className="mb-2 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        Blockers
      </h4>
      {issues.map((issue) => (
        <div key={issue.text} className="flex items-center gap-2.5 text-[12px]">
          <span className="w-3 shrink-0 text-center text-[11px]" style={{ color: issue.color }}>
            {issue.icon}
          </span>
          <span className="text-[var(--color-text-secondary)]">{issue.text}</span>
        </div>
      ))}
    </div>
  );
}

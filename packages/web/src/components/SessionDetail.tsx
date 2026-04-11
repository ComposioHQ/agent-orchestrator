"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useMediaQuery, MOBILE_BREAKPOINT } from "@/hooks/useMediaQuery";
import { type DashboardSession, type DashboardPR, isPRMergeReady } from "@/lib/types";
import { CI_STATUS } from "@aoagents/ao-core/types";
import { cn } from "@/lib/cn";
import dynamic from "next/dynamic";
import { getSessionTitle } from "@/lib/format";
import { CICheckList } from "./CIBadge";
import { MobileBottomNav } from "./MobileBottomNav";

const DirectTerminal = dynamic(
  () => import("./DirectTerminal").then((m) => ({ default: m.DirectTerminal })),
  {
    ssr: false,
    loading: () => (
      <div className="h-[440px] animate-pulse rounded bg-[var(--color-bg-primary)]" />
    ),
  },
);

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
  projectOrchestratorId?: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  "opencode": "OpenCode",
  "codex": "Codex",
  "aider": "Aider",
};

function formatAgentName(agent: string): string {
  return AGENT_DISPLAY_NAMES[agent] ?? agent.charAt(0).toUpperCase() + agent.slice(1);
}

const activityMeta: Record<string, { label: string; color: string }> = {
  active: { label: "Active", color: "var(--color-status-working)" },
  ready: { label: "Ready", color: "var(--color-status-ready)" },
  idle: { label: "Idle", color: "var(--color-status-idle)" },
  waiting_input: { label: "Waiting for input", color: "var(--color-status-attention)" },
  blocked: { label: "Blocked", color: "var(--color-status-error)" },
  exited: { label: "Exited", color: "var(--color-status-error)" },
};

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

// ── Orchestrator status strip — compact bar matching terminal chrome ──

function OrchestratorStatusStrip({
  zones,
  createdAt,
  headline,
  activityLabel,
  activityColor,
  crumbHref,
  crumbLabel,
  branch,
  pr,
}: {
  zones: OrchestratorZones;
  createdAt: string;
  headline: string;
  activityLabel: string;
  activityColor: string;
  crumbHref: string;
  crumbLabel: string;
  branch?: string;
  pr?: DashboardPR;
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
    { value: zones.merge, label: "merge", color: "#3fb950", bg: "rgba(63,185,80,0.1)" },
    { value: zones.respond, label: "respond", color: "#f85149", bg: "rgba(248,81,73,0.1)" },
    { value: zones.review, label: "review", color: "#d18616", bg: "rgba(209,134,22,0.1)" },
    { value: zones.working, label: "working", color: "#58a6ff", bg: "rgba(88,166,255,0.1)" },
    { value: zones.pending, label: "pending", color: "#d29922", bg: "rgba(210,153,34,0.1)" },
    { value: zones.done, label: "done", color: "#484f58", bg: "rgba(72,79,88,0.15)" },
  ].filter((s) => s.value > 0);

  const total =
    zones.merge + zones.respond + zones.review + zones.working + zones.pending + zones.done;

  return (
    <div className="mx-auto max-w-full px-3 pt-3 sm:px-5 sm:pt-4 lg:px-8">
      {/* Breadcrumb */}
      <div className="mb-2 flex items-center gap-1.5">
        <a
          href={crumbHref}
          className="flex items-center gap-1 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] hover:no-underline"
        >
          <svg className="h-3 w-3 opacity-60" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          {crumbLabel}
        </a>
        <span className="text-[11px] text-[var(--color-border-strong)]">/</span>
        <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)]">
          {headline}
        </span>
        <span
          className="ml-1 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.05em]"
          style={{
            color: "var(--color-accent)",
            background: "color-mix(in srgb, var(--color-accent) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-accent) 20%, transparent)",
            borderRadius: 6,
          }}
        >
          orchestrator
        </span>
        {branch ? (
          pr ? (
            <a
              href={buildGitHubBranchUrl(pr)}
              target="_blank"
              rel="noopener noreferrer"
              className="session-detail-link-pill session-detail-link-pill--link font-[var(--font-mono)] text-[10px] hover:no-underline"
            >
              {branch}
            </a>
          ) : (
            <span className="session-detail-link-pill font-[var(--font-mono)] text-[10px]">
              {branch}
            </span>
          )
        ) : null}
        {pr ? (
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="session-detail-link-pill session-detail-link-pill--link session-detail-link-pill--accent hover:no-underline"
          >
            PR #{pr.number}
          </a>
        ) : null}
      </div>
      {/* Compact status bar */}
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
        style={{
          padding: "8px 16px",
          background: "var(--color-bg-elevated)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          border: "1px solid var(--color-border-default)",
          borderRadius: 12,
          boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
        }}
      >
        {/* Title + activity */}
        <h1 className="text-[15px] font-semibold tracking-[-0.02em] text-[var(--color-text-primary)]">
          {headline}
        </h1>
        <div
          className="flex items-center gap-1.5 px-2 py-0.5"
          style={{
            background: `color-mix(in srgb, ${activityColor} 15%, transparent)`,
            border: `1px solid color-mix(in srgb, ${activityColor} 25%, transparent)`,
            borderRadius: 10,
          }}
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: activityColor }} />
          <span className="text-[10px] font-semibold" style={{ color: activityColor }}>
            {activityLabel}
          </span>
        </div>

        {/* Divider */}
        <div className="h-4 w-px bg-[var(--color-border-subtle)]" />

        {/* Agent count */}
        <span className="text-[13px] font-bold tabular-nums text-[var(--color-text-primary)]">{total}</span>
        <span className="text-[11px] text-[var(--color-text-tertiary)]">agents</span>

        {/* Zone pills */}
        {stats.map((s) => (
          <div
            key={s.label}
            className="flex items-center gap-1 px-2 py-0.5"
            style={{ background: s.bg, borderRadius: 4 }}
          >
            <span className="text-[12px] font-bold tabular-nums" style={{ color: s.color }}>
              {s.value}
            </span>
            <span className="text-[10px]" style={{ color: s.color, opacity: 0.8 }}>
              {s.label}
            </span>
          </div>
        ))}

        {/* Uptime — pushed to right */}
        {uptime ? (
          <span className="ml-auto font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)]">
            up {uptime}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────

export function SessionDetail({
  session,
  isOrchestrator = false,
  orchestratorZones,
  projectOrchestratorId = null,
}: SessionDetailProps) {
  const searchParams = useSearchParams();
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const startFullscreen = searchParams.get("fullscreen") === "true";
  const pr = session.pr;
  const activity = (session.activity && activityMeta[session.activity]) ?? {
    label: session.activity ?? "unknown",
    color: "var(--color-text-muted)",
  };
  const headline = getSessionTitle(session);

  const terminalVariant = isOrchestrator ? "orchestrator" : "agent";

  // Orchestrator: fill remaining viewport below the compact status strip
  // Worker: tall but not full-viewport (PR card may follow below)
  const terminalHeight = isOrchestrator
    ? "calc(100dvh - 140px)"
    : "clamp(520px, 72vh, 860px)";
  const isOpenCodeSession = session.metadata["agent"] === "opencode";
  const opencodeSessionId =
    typeof session.metadata["opencodeSessionId"] === "string" &&
    session.metadata["opencodeSessionId"].length > 0
      ? session.metadata["opencodeSessionId"]
      : undefined;
  const reloadCommand = opencodeSessionId
    ? `/exit\nopencode --session ${opencodeSessionId}\n`
    : undefined;
  const dashboardHref = session.projectId ? `/?project=${encodeURIComponent(session.projectId)}` : "/";
  const prsHref = session.projectId ? `/prs?project=${encodeURIComponent(session.projectId)}` : "/prs";
  const crumbHref = dashboardHref;
  const crumbLabel = isOrchestrator ? "Orchestrator" : "Dashboard";
  const orchestratorHref = useMemo(() => {
    if (isOrchestrator) return `/sessions/${encodeURIComponent(session.id)}`;
    if (!projectOrchestratorId) return null;
    return `/sessions/${encodeURIComponent(projectOrchestratorId)}`;
  }, [isOrchestrator, projectOrchestratorId, session.id]);

  return (
    <div className="session-detail-page min-h-screen bg-[var(--color-bg-base)]">
      {isOrchestrator && orchestratorZones && !isMobile && (
        <OrchestratorStatusStrip
          zones={orchestratorZones}
          createdAt={session.createdAt}
          headline={headline}
          activityLabel={activity.label}
          activityColor={activity.color}
          crumbHref={crumbHref}
          crumbLabel={crumbLabel}
          branch={session.branch ?? undefined}
          pr={pr ?? undefined}
        />
      )}

      <div className={cn(
        "dashboard-main mx-auto max-w-full px-3 sm:px-5 lg:px-8",
        isOrchestrator && orchestratorZones && !isMobile ? "py-2 sm:py-3" : "py-4 sm:py-5",
      )}>
        <main className="min-w-0">
          {/* ── Page header — breadcrumb, title, badges (page-level chrome) */}
          <div id="session-terminal-section" aria-hidden="true" />
          {(!isOrchestrator || isMobile) && (
            <div className="mb-5">
              {/* Breadcrumbs — headline omitted on mobile to avoid duplicate with h1 */}
              <div className="mb-2 flex items-center gap-1.5">
                <a
                  href={crumbHref}
                  className="flex items-center gap-1 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] hover:no-underline"
                >
                  <svg className="h-3 w-3 opacity-60" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                  {crumbLabel}
                </a>
                {!isMobile ? (
                  <>
                    <span className="text-[11px] text-[var(--color-border-strong)]">/</span>
                    <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)]">
                      {headline}
                    </span>
                  </>
                ) : null}
              </div>
              {/* Title + badges row */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <h1 className="truncate text-[17px] font-semibold tracking-[-0.03em] text-[var(--color-text-primary)]">
                  {headline}
                </h1>
                <div className="flex flex-wrap items-center gap-2">
                  <div
                    className="flex items-center gap-1.5 border px-2.5 py-1"
                    style={{
                      background: `color-mix(in srgb, ${activity.color} 12%, transparent)`,
                      border: `1px solid color-mix(in srgb, ${activity.color} 20%, transparent)`,
                      borderRadius: 6,
                    }}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: activity.color }} />
                    <span className="text-[11px] font-semibold" style={{ color: activity.color }}>
                      {activity.label}
                    </span>
                  </div>
                  {session.branch ? (
                    pr ? (
                      <a
                        href={buildGitHubBranchUrl(pr)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="session-detail-link-pill session-detail-link-pill--link font-[var(--font-mono)] text-[10px] hover:no-underline"
                      >
                        {session.branch}
                      </a>
                    ) : (
                      <span className="session-detail-link-pill font-[var(--font-mono)] text-[10px]">
                        {session.branch}
                      </span>
                    )
                  ) : null}
                  {pr ? (
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="session-detail-link-pill session-detail-link-pill--link session-detail-link-pill--accent hover:no-underline"
                    >
                      PR #{pr.number}
                    </a>
                  ) : null}
                </div>
              </div>
            </div>
          )}

          {pr ? (
            <section id="session-pr-section" className="mt-5">
              <SessionDetailPRCard pr={pr} sessionId={session.id} metadata={session.metadata} />
            </section>
          ) : null}

          <section className={pr ? "mt-6" : "mt-5"}>
            <div id="session-terminal-section" aria-hidden="true" />
            <div className="mb-3 flex items-center gap-2">
              <div
                className="h-3 w-0.5"
                style={{ background: isOrchestrator ? "var(--color-accent)" : activity.color, opacity: 0.75 }}
              />
              <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]">
                Live Terminal
              </span>
            </div>
            <DirectTerminal
              sessionId={session.id}
              startFullscreen={startFullscreen}
              variant={terminalVariant}
              height={terminalHeight}
              isOpenCodeSession={isOpenCodeSession}
              reloadCommand={isOpenCodeSession ? reloadCommand : undefined}
              agentName={session.metadata["agent"] ? formatAgentName(session.metadata["agent"]) : undefined}
              prNumber={pr?.number}
              prUrl={pr?.url}
            />
          </section>
        </main>
      </div>
      {isMobile ? (
        <MobileBottomNav
          ariaLabel="Session navigation"
          activeTab={isOrchestrator ? "orchestrator" : undefined}
          dashboardHref={dashboardHref}
          prsHref={prsHref}
          showOrchestrator={orchestratorHref !== null}
          orchestratorHref={orchestratorHref}
        />
      ) : null}
    </div>
  );
}

// ── Session detail PR card ────────────────────────────────────────────

function SessionDetailPRCard({ pr, sessionId, metadata }: { pr: DashboardPR; sessionId: string; metadata: Record<string, string> }) {
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

  const allGreen = isPRMergeReady(pr);

  const failedChecks = pr.ciChecks.filter((c) => c.status === "failed");

  const borderColor = allGreen
    ? "rgba(63,185,80,0.4)"
    : pr.state === "merged"
      ? "rgba(163,113,247,0.3)"
      : "var(--color-border-default)";

  return (
    <div className="detail-card mb-6 overflow-hidden border" style={{ borderColor }}>
      {/* Title row */}
      <div className="border-b border-[var(--color-border-subtle)] px-5 py-3.5">
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
                className="px-2 py-0.5 text-[10px] font-semibold"
                style={{
                  color: "var(--color-text-secondary)",
                  background: "var(--color-chip-bg)",
                }}
              >
                Merged
              </span>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-5 py-4">
        {/* Ready-to-merge banner */}
        {allGreen ? (
          <div className="flex items-center gap-2 border border-[rgba(63,185,80,0.25)] bg-[rgba(63,185,80,0.07)] px-3.5 py-2.5">
            <svg
              className="h-4 w-4 shrink-0 text-[var(--color-status-ready)]"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
            <span className="text-[13px] font-semibold text-[var(--color-status-ready)]">
              Ready to merge
            </span>
          </div>
        ) : (
          <IssuesList pr={pr} metadata={metadata} />
        )}

        {/* CI Checks */}
        {pr.ciChecks.length > 0 && (
          <div className="mt-4 border-t border-[var(--color-border-subtle)] pt-4">
            <CICheckList
              checks={pr.ciChecks}
              layout={failedChecks.length > 0 ? "expanded" : "inline"}
            />
          </div>
        )}

        {/* Unresolved comments */}
        {pr.unresolvedComments.length > 0 && (
          <div className="mt-4 border-t border-[var(--color-border-subtle)] pt-4">
            <h4 className="mb-2.5 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
              Unresolved Comments
              <span
                className="px-1.5 py-0.5 text-[10px] font-bold normal-case tracking-normal"
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
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-[12px] transition-colors hover:bg-[rgba(255,255,255,0.04)]">
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
                          "mt-1.5 px-3 py-1 text-[11px] font-semibold transition-colors duration-150",
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

function IssuesList({ pr, metadata }: { pr: DashboardPR; metadata: Record<string, string> }) {
  const issues: Array<{ icon: string; color: string; text: string; notified?: boolean }> = [];

  const ciNotified = Boolean(metadata["lastCIFailureDispatchHash"]);
  const conflictNotified = metadata["lastMergeConflictDispatched"] === "true";
  const reviewNotified = Boolean(metadata["lastPendingReviewDispatchHash"]);

  // The lifecycle manager's status is the most up-to-date source of truth.
  // PR enrichment data can be stale (5-min cache) or unavailable (rate limit/timeout).
  // Use lifecycle status as fallback when PR data hasn't caught up yet.
  const lifecycleStatus = metadata["status"];

  const ciIsFailing = pr.ciStatus === CI_STATUS.FAILING || lifecycleStatus === "ci_failed";
  const hasChangesRequested =
    pr.reviewDecision === "changes_requested" || lifecycleStatus === "changes_requested";
  const hasConflicts = pr.state !== "merged" && !pr.mergeability.noConflicts;

  if (ciIsFailing) {
    const failCount = pr.ciChecks.filter((c) => c.status === "failed").length;
    issues.push({
      icon: "✗",
      color: "var(--color-status-error)",
      text:
        failCount > 0
          ? `CI failing — ${failCount} check${failCount !== 1 ? "s" : ""} failed`
          : "CI failing",
      notified: ciNotified,
    });
  } else if (pr.ciStatus === CI_STATUS.PENDING) {
    issues.push({ icon: "●", color: "var(--color-status-attention)", text: "CI pending" });
  }

  if (hasChangesRequested) {
    issues.push({
      icon: "✗",
      color: "var(--color-status-error)",
      text: "Changes requested",
      notified: reviewNotified,
    });
  } else if (!pr.mergeability.approved) {
    issues.push({
      icon: "○",
      color: "var(--color-text-tertiary)",
      text: "Not approved — awaiting reviewer",
    });
  }

  if (hasConflicts) {
    issues.push({
      icon: "✗",
      color: "var(--color-status-error)",
      text: "Merge conflicts",
      notified: conflictNotified,
    });
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
          {issue.notified && (
            <span className="text-[10px] text-[var(--color-text-tertiary)]">
              · agent notified
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

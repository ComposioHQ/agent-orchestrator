"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import {
  type DashboardSession,
  type DashboardPR,
} from "@/lib/types";
import { CICheckList } from "./CIBadge";
import { DirectTerminal } from "./DirectTerminal";

interface SessionDetailProps {
  session: DashboardSession;
}

// ── Helpers ──────────────────────────────────────────────────────────

const activityLabel: Record<string, { label: string; color: string }> = {
  active: { label: "Active", color: "var(--color-accent-green)" },
  idle: { label: "Idle", color: "var(--color-text-muted)" },
  waiting_input: { label: "Waiting for input", color: "var(--color-accent-yellow)" },
  blocked: { label: "Blocked", color: "var(--color-accent-red)" },
  exited: { label: "Exited", color: "var(--color-accent-red)" },
};

/** Converts snake_case status enum to Title Case display string. */
function humanizeStatus(status: string): string {
  return status
    .replace(/_/g, " ")
    .replace(/\bci\b/gi, "CI")
    .replace(/\bpr\b/gi, "PR")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Converts ISO date string to relative time like "3h ago", "2m ago". Client-side only. */
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Clean up review comment body - extract title and description, remove HTML junk */
function cleanBugbotComment(body: string): { title: string; description: string } {
  // Check if this is a Bugbot comment (has structured markers)
  const isBugbot = body.includes("<!-- DESCRIPTION START -->") || body.includes("### ");

  if (isBugbot) {
    // Extract title (first ### heading)
    const titleMatch = body.match(/###\s+(.+?)(?:\n|$)/);
    const title = titleMatch ? titleMatch[1].replace(/\*\*/g, "").trim() : "Comment";

    // Extract description between DESCRIPTION START/END comments
    const descMatch = body.match(/<!-- DESCRIPTION START -->\s*([\s\S]*?)\s*<!-- DESCRIPTION END -->/);
    const description = descMatch ? descMatch[1].trim() : body.split("\n")[0] || "No description";

    return { title, description };
  } else {
    // For non-Bugbot comments, use full body as description
    return { title: "Comment", description: body.trim() };
  }
}

/** Builds a GitHub branch URL from PR owner/repo/branch. */
function buildGitHubBranchUrl(pr: DashboardPR): string {
  return `https://github.com/${pr.owner}/${pr.repo}/tree/${pr.branch}`;
}

/** Builds a GitHub repo URL from PR owner/repo. */
function buildGitHubRepoUrl(pr: DashboardPR): string {
  return `https://github.com/${pr.owner}/${pr.repo}`;
}

// ── Main Component ───────────────────────────────────────────────────

/** Ask the agent to fix a specific review comment */
async function askAgentToFix(
  sessionId: string,
  comment: { url: string; path: string; body: string },
) {
  try {
    const { title, description } = cleanBugbotComment(comment.body);
    const message = `Please address this review comment:\n\nFile: ${comment.path}\nComment: ${title}\nDescription: ${description}\n\nComment URL: ${comment.url}\n\nAfter fixing, mark the comment as resolved at ${comment.url}`;

    // TODO: Implement API endpoint to send message to agent session
    const res = await fetch(`/api/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    alert("Message sent to agent");
  } catch (err) {
    console.error("Failed to send message to agent:", err);
    alert("Failed to send message to agent");
  }
}

export function SessionDetail({ session }: SessionDetailProps) {
  const searchParams = useSearchParams();
  const startFullscreen = searchParams.get("fullscreen") === "true";
  const pr = session.pr;
  const activity = activityLabel[session.activity] ?? {
    label: session.activity,
    color: "var(--color-text-muted)",
  };

  return (
    <div className="min-h-screen">
      {/* Nav bar */}
      <nav className="border-b border-[var(--color-border-muted)] bg-[var(--color-bg-secondary)]">
        <div className="mx-auto flex max-w-[900px] items-center px-8 py-2">
          <a
            href="/"
            className="text-xs font-medium tracking-wide text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:no-underline"
          >
            &larr; Agent Orchestrator
          </a>
        </div>
      </nav>

      <div className="mx-auto max-w-[900px] px-8 py-6">
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="mb-6">
          {/* Session ID + badges */}
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{session.id}</h1>
            <span
              className="rounded-full px-2 py-0.5 text-xs font-semibold"
              style={{
                color: activity.color,
                background: `color-mix(in srgb, ${activity.color} 15%, transparent)`,
              }}
            >
              {activity.label}
            </span>
          </div>

          {/* Summary */}
          {session.summary && (
            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">{session.summary}</p>
          )}

          {/* Meta chips: PR · branch · issue */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
            {session.projectId && (
              <>
                {pr ? (
                  <a
                    href={buildGitHubRepoUrl(pr)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:no-underline"
                  >
                    {session.projectId}
                  </a>
                ) : (
                  <span className="rounded-md bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[var(--color-text-secondary)]">
                    {session.projectId}
                  </span>
                )}
                <span className="text-[var(--color-text-muted)]">&middot;</span>
              </>
            )}

            {pr && (
              <>
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-md bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:no-underline"
                >
                  #{pr.number}
                </a>
                {(session.branch || session.issueUrl) && (
                  <span className="text-[var(--color-text-muted)]">&middot;</span>
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
                    className="rounded-md bg-[var(--color-bg-tertiary)] px-2 py-0.5 font-[var(--font-mono)] text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:no-underline"
                  >
                    {session.branch}
                  </a>
                ) : (
                  <span className="rounded-md bg-[var(--color-bg-tertiary)] px-2 py-0.5 font-[var(--font-mono)] text-[11px] text-[var(--color-text-secondary)]">
                    {session.branch}
                  </span>
                )}
                {session.issueUrl && (
                  <span className="text-[var(--color-text-muted)]">&middot;</span>
                )}
              </>
            )}

            {session.issueUrl && (
              <a
                href={session.issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:no-underline"
              >
                {session.issueLabel || session.issueUrl}
              </a>
            )}
          </div>

          {/* Status · timestamps */}
          <ClientTimestamps
            status={session.status}
            createdAt={session.createdAt}
            lastActivityAt={session.lastActivityAt}
          />
        </div>

        {/* ── PR Card ────────────────────────────────────────────── */}
        {pr && <PRCard pr={pr} sessionId={session.id} />}

        {/* ── Terminal ───────────────────────────────────────────── */}
        <div className="mt-6">
          <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-widest text-[var(--color-text-muted)]">
            Terminal
          </h3>

          <DirectTerminal sessionId={session.id} startFullscreen={startFullscreen} />
        </div>
      </div>
    </div>
  );
}

// ── Client-side timestamps (avoids hydration mismatch) ───────────────

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
    <div className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-[var(--color-text-muted)]">
      <span>{humanizeStatus(status)}</span>
      {created && (
        <>
          <span>&middot;</span>
          <span>Created {created}</span>
        </>
      )}
      {lastActive && (
        <>
          <span>&middot;</span>
          <span>Active {lastActive}</span>
        </>
      )}
    </div>
  );
}

// ── PR Card ──────────────────────────────────────────────────────────

function PRCard({ pr, sessionId }: { pr: DashboardPR; sessionId: string }) {
  const allGreen =
    pr.mergeability.mergeable &&
    pr.mergeability.ciPassing &&
    pr.mergeability.approved &&
    pr.mergeability.noConflicts;

  const failedChecks = pr.ciChecks.filter((c) => c.status === "failed");
  const hasFailures = failedChecks.length > 0;

  return (
    <div className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)]">
      {/* Title row */}
      <div className="border-b border-[var(--color-border-muted)] px-4 py-3">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-[var(--color-text-primary)] hover:text-[var(--color-accent-blue)]"
        >
          PR #{pr.number}: {pr.title}
        </a>

        {/* Stats row */}
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-[var(--color-text-muted)]">
            <span className="text-[var(--color-accent-green)]">+{pr.additions}</span>{" "}
            <span className="text-[var(--color-accent-red)]">-{pr.deletions}</span>
          </span>

          {pr.isDraft && (
            <>
              <span className="text-[var(--color-text-muted)]">&middot;</span>
              <span className="font-semibold text-[var(--color-text-muted)]">Draft</span>
            </>
          )}

          {pr.state === "merged" && (
            <>
              <span className="text-[var(--color-text-muted)]">&middot;</span>
              <span className="font-semibold text-[var(--color-accent-violet)]">Merged</span>
            </>
          )}

        </div>
      </div>

      {/* Body */}
      <div className="px-4 py-3">
        {/* Ready to merge or issues list */}
        {allGreen ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-[var(--color-accent-green)]">{"\u2713"}</span>
            <span className="font-semibold text-[var(--color-accent-green)]">Ready to merge</span>
          </div>
        ) : (
          <IssuesList pr={pr} />
        )}

        {/* CI Checks — inline row */}
        {pr.ciChecks.length > 0 && (
          <div className="mt-3 border-t border-[var(--color-border-muted)] pt-3">
            <CICheckList checks={pr.ciChecks} layout={hasFailures ? "expanded" : "inline"} />
          </div>
        )}

        {/* Unresolved Comments */}
        {pr.unresolvedComments.length > 0 && (
          <div className="mt-3 border-t border-[var(--color-border-muted)] pt-3">
            <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Unresolved Comments ({pr.unresolvedThreads})
            </h4>
            <div className="space-y-1.5">
              {pr.unresolvedComments.map((c) => {
                const { title, description } = cleanBugbotComment(c.body);
                return (
                  <details key={c.url} className="group">
                    <summary className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-[var(--color-bg-tertiary)] [&::-webkit-details-marker]:hidden">
                      <svg
                        className="h-3 w-3 shrink-0 text-[var(--color-text-muted)] transition-transform group-open:rotate-90"
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
                      <span className="text-[var(--color-text-muted)]">· {c.author}</span>
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="ml-auto text-[10px] text-[var(--color-accent-blue)] hover:underline"
                      >
                        view →
                      </a>
                    </summary>
                    <div className="ml-5 mt-1 space-y-1.5 px-2 pb-2">
                      <div className="text-[10px] font-[var(--font-mono)] text-[var(--color-text-muted)]">
                        {c.path}
                      </div>
                      <p className="border-l-2 border-[var(--color-border-default)] pl-3 text-xs leading-relaxed text-[var(--color-text-secondary)]">
                        {description}
                      </p>
                      <button
                        onClick={() => askAgentToFix(sessionId, c)}
                        className="mt-2 rounded-md bg-[var(--color-accent-blue)] px-3 py-1 text-[10px] font-medium text-white hover:opacity-90"
                      >
                        Ask Agent to Fix
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

// ── Issues List (replaces merge readiness grid + blockers) ───────────

function IssuesList({ pr }: { pr: DashboardPR }) {
  const issues: Array<{ icon: string; color: string; text: string }> = [];

  if (pr.ciStatus === "failing") {
    const failCount = pr.ciChecks.filter((c) => c.status === "failed").length;
    const text = failCount > 0
      ? `CI failing \u2014 ${failCount} check${failCount !== 1 ? "s" : ""} failed`
      : "CI failing";
    issues.push({
      icon: "\u2717",
      color: "var(--color-accent-red)",
      text,
    });
  } else if (pr.ciStatus === "pending") {
    issues.push({
      icon: "\u25CF",
      color: "var(--color-accent-yellow)",
      text: "CI pending",
    });
  }

  if (pr.reviewDecision === "changes_requested") {
    issues.push({
      icon: "\u2717",
      color: "var(--color-accent-red)",
      text: "Changes requested",
    });
  } else if (!pr.mergeability.approved) {
    issues.push({
      icon: "\u25CB",
      color: "var(--color-text-muted)",
      text: "Not approved \u2014 awaiting reviewer",
    });
  }

  if (!pr.mergeability.noConflicts) {
    issues.push({
      icon: "\u2717",
      color: "var(--color-accent-red)",
      text: "Merge conflicts",
    });
  }

  if (!pr.mergeability.mergeable && issues.length === 0) {
    issues.push({
      icon: "\u25CB",
      color: "var(--color-text-muted)",
      text: "Not mergeable",
    });
  }

  if (pr.unresolvedThreads > 0) {
    issues.push({
      icon: "\u25CF",
      color: "var(--color-accent-yellow)",
      text: `${pr.unresolvedThreads} unresolved comment${pr.unresolvedThreads !== 1 ? "s" : ""}`,
    });
  }

  if (pr.isDraft) {
    issues.push({
      icon: "\u25CB",
      color: "var(--color-text-muted)",
      text: "Draft PR",
    });
  }

  if (issues.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        Issues
      </h4>
      {issues.map((issue) => (
        <div key={issue.text} className="flex items-center gap-2 text-xs">
          <span style={{ color: issue.color }}>{issue.icon}</span>
          <span className="text-[var(--color-text-secondary)]">{issue.text}</span>
        </div>
      ))}
    </div>
  );
}


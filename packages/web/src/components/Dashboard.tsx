"use client";

import { useMemo, useState, useEffect, useCallback } from "react";
import {
  type DashboardSession,
  type DashboardStats,
  type DashboardPR,
  type AttentionLevel,
  getAttentionLevel,
  isPRRateLimited,
} from "@/lib/types";
import { CI_STATUS } from "@composio/ao-core/types";
import { AttentionZone } from "./AttentionZone";
import { PRTableRow } from "./PRStatus";
import { DynamicFavicon } from "./DynamicFavicon";
import { useSessionEvents } from "@/hooks/useSessionEvents";

interface BacklogIssue {
  id: string;
  title: string;
  url: string;
  state: string;
  labels: string[];
  projectId: string;
}

interface DashboardProps {
  initialSessions: DashboardSession[];
  stats: DashboardStats;
  orchestratorId?: string | null;
  projectName?: string;
  projectIds?: string[];
}

type Tab = "board" | "backlog" | "verify" | "prs";

const KANBAN_LEVELS = ["working", "pending", "review", "respond", "merge"] as const;

export function Dashboard({ initialSessions, stats, orchestratorId, projectName, projectIds = [] }: DashboardProps) {
  const sessions = useSessionEvents(initialSessions);
  const [rateLimitDismissed, setRateLimitDismissed] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("board");
  const [backlogIssues, setBacklogIssues] = useState<BacklogIssue[]>([]);
  const [backlogLoading, setBacklogLoading] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [verifyIssues, setVerifyIssues] = useState<BacklogIssue[]>([]);
  const [verifyLoading, setVerifyLoading] = useState(false);

  const grouped = useMemo(() => {
    const zones: Record<AttentionLevel, DashboardSession[]> = {
      merge: [],
      respond: [],
      review: [],
      pending: [],
      working: [],
      done: [],
    };
    for (const session of sessions) {
      zones[getAttentionLevel(session)].push(session);
    }
    return zones;
  }, [sessions]);

  const openPRs = useMemo(() => {
    return sessions
      .filter((s): s is DashboardSession & { pr: DashboardPR } => s.pr?.state === "open")
      .map((s) => s.pr)
      .sort((a, b) => mergeScore(a) - mergeScore(b));
  }, [sessions]);

  // Fetch backlog issues
  const fetchBacklog = useCallback(async () => {
    setBacklogLoading(true);
    try {
      const res = await fetch("/api/backlog");
      if (res.ok) {
        const data = await res.json();
        setBacklogIssues(data.issues ?? []);
      }
    } catch {
      // Non-critical
    } finally {
      setBacklogLoading(false);
    }
  }, []);

  // Fetch verify issues
  const fetchVerify = useCallback(async () => {
    setVerifyLoading(true);
    try {
      const res = await fetch("/api/verify");
      if (res.ok) {
        const data = await res.json();
        setVerifyIssues(data.issues ?? []);
      }
    } catch {
      // Non-critical
    } finally {
      setVerifyLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "verify") {
      fetchVerify();
      const interval = setInterval(fetchVerify, 30_000);
      return () => clearInterval(interval);
    }
  }, [activeTab, fetchVerify]);

  const handleVerifyAction = async (issueId: string, projectId: string, action: "verify" | "fail") => {
    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId, projectId, action }),
      });
      if (res.ok) {
        setVerifyIssues((prev) => prev.filter((i) => !(i.id === issueId && i.projectId === projectId)));
      } else {
        console.error("Failed to update verify status:", await res.text());
      }
    } catch (err) {
      console.error("Failed to update verify status:", err);
    }
  };

  useEffect(() => {
    if (activeTab === "backlog") {
      fetchBacklog();
      const interval = setInterval(fetchBacklog, 30_000);
      return () => clearInterval(interval);
    }
  }, [activeTab, fetchBacklog]);

  const handleSend = async (sessionId: string, message: string) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      console.error(`Failed to send message to ${sessionId}:`, await res.text());
    }
  };

  const handleKill = async (sessionId: string) => {
    if (!confirm(`Kill session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to kill ${sessionId}:`, await res.text());
    }
  };

  const handleMerge = async (prNumber: number) => {
    const res = await fetch(`/api/prs/${prNumber}/merge`, { method: "POST" });
    if (!res.ok) {
      console.error(`Failed to merge PR #${prNumber}:`, await res.text());
    }
  };

  const handleRestore = async (sessionId: string) => {
    if (!confirm(`Restore session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to restore ${sessionId}:`, await res.text());
    }
  };

  const hasKanbanSessions = KANBAN_LEVELS.some((l) => grouped[l].length > 0);

  const anyRateLimited = useMemo(
    () => sessions.some((s) => s.pr && isPRRateLimited(s.pr)),
    [sessions],
  );

  // Counts for tab badges
  const backlogCount = backlogIssues.length;
  const verifyCount = verifyIssues.length;
  const prCount = openPRs.length;
  const needsAttention = grouped.respond.length + grouped.merge.length;

  return (
    <div className="px-8 py-7">
      <DynamicFavicon sessions={sessions} projectName={projectName} />

      {/* Header */}
      <div className="mb-6 flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-5">
        <div className="flex items-center gap-6">
          <h1 className="text-[17px] font-semibold tracking-[-0.02em] text-[var(--color-text-primary)]">
            {projectName ?? "Orchestrator"}
          </h1>
          <StatusLine stats={stats} needsAttention={needsAttention} />
        </div>
        <div className="flex items-center gap-3">
          {orchestratorId && (
            <a
              href={`/sessions/${encodeURIComponent(orchestratorId)}`}
              className="orchestrator-btn flex items-center gap-2 rounded-[7px] px-4 py-2 text-[12px] font-semibold hover:no-underline"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent-violet)] opacity-80" />
              terminal
              <svg className="h-3 w-3 opacity-70" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
              </svg>
            </a>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="mb-6 flex items-center gap-1 border-b border-[var(--color-border-subtle)]">
        <TabButton active={activeTab === "board"} onClick={() => setActiveTab("board")} badge={needsAttention > 0 ? needsAttention : undefined} badgeColor="var(--color-status-error)">
          Board
        </TabButton>
        <TabButton active={activeTab === "backlog"} onClick={() => setActiveTab("backlog")} badge={backlogCount > 0 ? backlogCount : undefined} badgeColor="var(--color-accent)">
          Backlog
        </TabButton>
        <TabButton active={activeTab === "verify"} onClick={() => setActiveTab("verify")} badge={verifyCount > 0 ? verifyCount : undefined} badgeColor="rgb(245, 158, 11)">
          Verify
        </TabButton>
        <TabButton active={activeTab === "prs"} onClick={() => setActiveTab("prs")} badge={prCount > 0 ? prCount : undefined} badgeColor="var(--color-status-ready)">
          Pull Requests
        </TabButton>
      </div>

      {/* Rate limit notice */}
      {anyRateLimited && !rateLimitDismissed && (
        <div className="mb-6 flex items-center gap-2.5 rounded border border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.05)] px-3.5 py-2.5 text-[11px] text-[var(--color-status-attention)]">
          <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <span className="flex-1">
            GitHub API rate limited — PR data may be stale. Will retry automatically.
          </span>
          <button onClick={() => setRateLimitDismissed(true)} className="ml-1 shrink-0 opacity-60 hover:opacity-100" aria-label="Dismiss">
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Board tab */}
      {activeTab === "board" && (
        <>
          {/* Kanban columns for active zones */}
          {hasKanbanSessions ? (
            <div className="mb-8 flex gap-4 overflow-x-auto pb-2">
              {KANBAN_LEVELS.map((level) =>
                grouped[level].length > 0 ? (
                  <div key={level} className="min-w-[200px] flex-1">
                    <AttentionZone
                      level={level}
                      sessions={grouped[level]}
                      variant="column"
                      onSend={handleSend}
                      onKill={handleKill}
                      onMerge={handleMerge}
                      onRestore={handleRestore}
                    />
                  </div>
                ) : null,
              )}
            </div>
          ) : (
            <EmptyState
              title="No active sessions"
              description="Add issues to your backlog or spawn agents from the CLI"
              action={
                <button
                  onClick={() => setActiveTab("backlog")}
                  className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-[var(--color-text-inverse)] hover:opacity-90"
                >
                  View Backlog
                </button>
              }
            />
          )}

          {/* Done — full-width grid below Kanban */}
          {grouped.done.length > 0 && (
            <div className="mb-8">
              <AttentionZone
                level="done"
                sessions={grouped.done}
                variant="grid"
                onSend={handleSend}
                onKill={handleKill}
                onMerge={handleMerge}
                onRestore={handleRestore}
              />
            </div>
          )}
        </>
      )}

      {/* Backlog tab */}
      {activeTab === "backlog" && (
        <div>
          <div className="mb-4 flex items-center justify-between">
            <p className="text-[12px] text-[var(--color-text-secondary)]">
              Issues labeled <code className="rounded bg-[var(--color-bg-subtle)] px-1.5 py-0.5 text-[11px] text-[var(--color-accent)]">agent:backlog</code> are auto-claimed by agents. Max {5} concurrent.
            </p>
            <button
              onClick={() => setShowCreateForm(!showCreateForm)}
              className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-semibold text-[var(--color-text-inverse)] hover:opacity-90"
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New Issue
            </button>
          </div>

          {showCreateForm && (
            <CreateIssueForm
              projectIds={projectIds}
              onCreated={() => { setShowCreateForm(false); fetchBacklog(); }}
              onCancel={() => setShowCreateForm(false)}
            />
          )}

          {backlogLoading && backlogIssues.length === 0 ? (
            <div className="py-12 text-center text-[12px] text-[var(--color-text-tertiary)]">Loading backlog...</div>
          ) : backlogIssues.length === 0 ? (
            <EmptyState
              title="Backlog is empty"
              description={`Add the "agent:backlog" label to GitHub issues, or create one above`}
            />
          ) : (
            <div className="space-y-2">
              {backlogIssues.map((issue) => (
                <BacklogCard key={`${issue.projectId}-${issue.id}`} issue={issue} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Verify tab */}
      {activeTab === "verify" && (
        <div>
          <div className="mb-4">
            <p className="text-[12px] text-[var(--color-text-secondary)]">
              Issues labeled <code className="rounded bg-[var(--color-bg-subtle)] px-1.5 py-0.5 text-[11px]" style={{ color: "rgb(245, 158, 11)" }}>merged-unverified</code> need human verification on staging.
            </p>
          </div>

          {verifyLoading && verifyIssues.length === 0 ? (
            <div className="py-12 text-center text-[12px] text-[var(--color-text-tertiary)]">Loading issues to verify...</div>
          ) : verifyIssues.length === 0 ? (
            <EmptyState
              title="Nothing to verify"
              description="All merged issues have been verified"
            />
          ) : (
            <div className="space-y-2">
              {verifyIssues.map((issue) => (
                <VerifyCard
                  key={`${issue.projectId}-${issue.id}`}
                  issue={issue}
                  onVerify={() => handleVerifyAction(issue.id, issue.projectId, "verify")}
                  onFail={() => handleVerifyAction(issue.id, issue.projectId, "fail")}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* PRs tab */}
      {activeTab === "prs" && (
        <>
          {openPRs.length > 0 ? (
            <div className="mx-auto max-w-[900px]">
              <div className="overflow-hidden rounded-[6px] border border-[var(--color-border-default)]">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--color-border-muted)]">
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">PR</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Title</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Size</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">CI</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Review</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Unresolved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openPRs.map((pr) => (
                      <PRTableRow key={pr.number} pr={pr} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <EmptyState title="No open PRs" description="Agents will create PRs when they push code" />
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TabButton({ active, onClick, badge, badgeColor, children }: {
  active: boolean;
  onClick: () => void;
  badge?: number;
  badgeColor?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative px-4 py-2.5 text-[12px] font-semibold transition-colors ${
        active
          ? "border-b-2 border-[var(--color-accent)] text-[var(--color-text-primary)]"
          : "border-b-2 border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
      }`}
    >
      {children}
      {badge !== undefined && badge > 0 && (
        <span
          className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
          style={{ backgroundColor: badgeColor ?? "var(--color-accent)" }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function EmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[var(--color-border-subtle)] py-16">
      <div className="text-[14px] font-medium text-[var(--color-text-secondary)]">{title}</div>
      <div className="max-w-[400px] text-center text-[12px] text-[var(--color-text-tertiary)]">{description}</div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

function BacklogCard({ issue }: { issue: BacklogIssue }) {
  return (
    <a
      href={issue.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-4 py-3 transition-colors hover:border-[var(--color-border-default)] hover:no-underline"
    >
      <svg className="h-4 w-4 shrink-0 text-[var(--color-status-ready)]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v8M8 12h8" />
      </svg>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-[var(--color-text-primary)] truncate">
          #{issue.id} {issue.title}
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="text-[11px] text-[var(--color-text-tertiary)]">{issue.projectId}</span>
          {issue.labels.filter(l => l !== "agent:backlog").map(label => (
            <span key={label} className="rounded-full bg-[var(--color-bg-subtle)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
              {label}
            </span>
          ))}
        </div>
      </div>
      <span className="rounded-full bg-[rgba(88,166,255,0.1)] px-2.5 py-1 text-[10px] font-semibold text-[var(--color-accent)]">
        queued
      </span>
    </a>
  );
}

function VerifyCard({ issue, onVerify, onFail }: { issue: BacklogIssue; onVerify: () => void; onFail: () => void }) {
  const [acting, setActing] = useState<"verify" | "fail" | null>(null);

  const handleAction = async (action: "verify" | "fail", handler: () => void) => {
    setActing(action);
    try {
      await handler();
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-4 py-3">
      <svg className="h-4 w-4 shrink-0" style={{ color: "rgb(245, 158, 11)" }} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
      <div className="flex-1 min-w-0">
        <a
          href={issue.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[13px] font-medium text-[var(--color-text-primary)] truncate hover:underline"
        >
          #{issue.id} {issue.title}
        </a>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="text-[11px] text-[var(--color-text-tertiary)]">{issue.projectId}</span>
          {issue.labels.filter(l => l !== "merged-unverified").map(label => (
            <span key={label} className="rounded-full bg-[var(--color-bg-subtle)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
              {label}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => handleAction("verify", onVerify)}
          disabled={acting !== null}
          className="rounded-md bg-[rgba(46,160,67,0.15)] px-3 py-1.5 text-[11px] font-semibold text-[rgb(46,160,67)] hover:bg-[rgba(46,160,67,0.25)] disabled:opacity-50"
        >
          {acting === "verify" ? "..." : "Verified"}
        </button>
        <button
          onClick={() => handleAction("fail", onFail)}
          disabled={acting !== null}
          className="rounded-md bg-[rgba(248,81,73,0.15)] px-3 py-1.5 text-[11px] font-semibold text-[rgb(248,81,73)] hover:bg-[rgba(248,81,73,0.25)] disabled:opacity-50"
        >
          {acting === "fail" ? "..." : "Failed"}
        </button>
      </div>
    </div>
  );
}

function CreateIssueForm({ projectIds, onCreated, onCancel }: { projectIds: string[]; onCreated: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedProject, setSelectedProject] = useState(projectIds[0] ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !selectedProject) return;

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: selectedProject,
          title: title.trim(),
          description: description.trim(),
          addToBacklog: true,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to create issue");
      }

      setTitle("");
      setDescription("");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create issue");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="mb-6 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4">
      {projectIds.length > 1 && (
        <div className="mb-3">
          <select
            value={selectedProject}
            onChange={(e) => setSelectedProject(e.target.value)}
            className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[13px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
          >
            {projectIds.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </div>
      )}
      <div className="mb-3">
        <input
          type="text"
          placeholder="Issue title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[13px] text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent)]"
          autoFocus
        />
      </div>
      <div className="mb-3">
        <textarea
          placeholder="Description (optional — be specific about what the agent should do)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-[13px] text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent)] resize-none"
        />
      </div>
      {error && (
        <div className="mb-3 text-[11px] text-[var(--color-status-error)]">{error}</div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-[var(--color-text-tertiary)]">
          Will be created with <code className="text-[var(--color-accent)]">agent:backlog</code> label
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !title.trim()}
            className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-semibold text-[var(--color-text-inverse)] hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Creating..." : "Create & Queue"}
          </button>
        </div>
      </div>
    </form>
  );
}

function StatusLine({ stats, needsAttention }: { stats: DashboardStats; needsAttention: number }) {
  if (stats.totalSessions === 0) {
    return <span className="text-[13px] text-[var(--color-text-muted)]">no sessions</span>;
  }

  const parts: Array<{ value: number; label: string; color?: string }> = [
    { value: stats.totalSessions, label: "sessions" },
    ...(stats.workingSessions > 0
      ? [{ value: stats.workingSessions, label: "working", color: "var(--color-status-working)" }]
      : []),
    ...(stats.openPRs > 0 ? [{ value: stats.openPRs, label: "PRs" }] : []),
    ...(needsAttention > 0
      ? [{ value: needsAttention, label: "need attention", color: "var(--color-status-error)" }]
      : []),
  ];

  return (
    <div className="flex items-baseline gap-0.5">
      {parts.map((p, i) => (
        <span key={p.label} className="flex items-baseline">
          {i > 0 && (
            <span className="mx-3 text-[11px] text-[var(--color-border-strong)]">&middot;</span>
          )}
          <span
            className="text-[20px] font-bold tabular-nums tracking-tight"
            style={{ color: p.color ?? "var(--color-text-primary)" }}
          >
            {p.value}
          </span>
          <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">
            {p.label}
          </span>
        </span>
      ))}
    </div>
  );
}

function mergeScore(
  pr: Pick<DashboardPR, "ciStatus" | "reviewDecision" | "mergeability" | "unresolvedThreads">,
): number {
  let score = 0;
  if (!pr.mergeability.noConflicts) score += 40;
  if (pr.ciStatus === CI_STATUS.FAILING) score += 30;
  else if (pr.ciStatus === CI_STATUS.PENDING) score += 5;
  if (pr.reviewDecision === "changes_requested") score += 20;
  else if (pr.reviewDecision !== "approved") score += 10;
  score += pr.unresolvedThreads * 5;
  return score;
}

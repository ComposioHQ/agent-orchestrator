"use client";

import { useState, useCallback, useMemo } from "react";
import type { ColumnConfig } from "@/lib/project-name";

interface BacklogIssue {
  projectId: string;
  id: string;
  title: string;
  url: string;
  state: string;
  labels: string[];
  assignee?: string;
  issueType?: string;
  statusName?: string;
}

interface BacklogPanelProps {
  projectId: string;
  triggerLabels?: string[];
  /** Default assignee filter from project config (tracker.trigger.assignee) */
  triggerAssignee?: string;
  columns?: ColumnConfig[];
}

// ---------------------------------------------------------------------------
// Column grouping logic
// ---------------------------------------------------------------------------

interface ResolvedColumn {
  label: string;
  issues: BacklogIssue[];
}

function groupIssuesIntoColumns(issues: BacklogIssue[], columns: ColumnConfig[]): ResolvedColumn[] {
  const assigned = new Set<string>();
  const namedColumns: ResolvedColumn[] = columns.map((col) => {
    const matched = issues.filter((issue) => {
      if (!col.statuses || col.statuses.length === 0) return false;
      return col.statuses.includes(issue.statusName ?? "");
    });
    matched.forEach((i) => assigned.add(i.id));
    return { label: col.label, issues: matched };
  });

  const other = issues.filter((i) => !assigned.has(i.id));
  // Only add the "Other" column if there are unassigned issues
  if (other.length > 0) {
    return [{ label: "Other", issues: other }, ...namedColumns];
  }
  return namedColumns;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function BacklogPanel({
  projectId,
  triggerLabels,
  triggerAssignee,
  columns,
}: BacklogPanelProps) {
  const [issues, setIssues] = useState<BacklogIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spawning, setSpawning] = useState<Record<string, boolean>>({});
  const [spawnedIds, setSpawnedIds] = useState<Set<string>>(new Set());
  const [spawnErrors, setSpawnErrors] = useState<Record<string, string>>({});
  const [polled, setPolled] = useState(false);
  const [assigneeFilter, setAssigneeFilter] = useState(triggerAssignee ?? "");

  const labelParam = triggerLabels?.[0];

  const handlePoll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ project: projectId, state: "open" });
      if (labelParam) params.set("label", labelParam);
      if (assigneeFilter.trim()) params.set("assignee", assigneeFilter.trim());
      const res = await fetch(`/api/issues?${params.toString()}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { issues: BacklogIssue[] };
      setIssues(data.issues);
      setPolled(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch issues");
    } finally {
      setLoading(false);
    }
  }, [projectId, labelParam, assigneeFilter]);

  const handleSpawn = useCallback(
    async (issue: BacklogIssue) => {
      setSpawning((s) => ({ ...s, [issue.id]: true }));
      setSpawnErrors(({ [issue.id]: _ignored, ...rest }) => rest);
      try {
        const res = await fetch("/api/spawn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, issueId: issue.id }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? `HTTP ${res.status}`);
        }
        setSpawnedIds((prev) => new Set([...prev, issue.id]));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to spawn agent";
        setSpawnErrors((current) => ({ ...current, [issue.id]: message }));
      } finally {
        setSpawning(({ [issue.id]: _removed, ...rest }) => rest);
      }
    },
    [projectId],
  );

  // Compute column groups whenever issues or column config changes
  const columnGroups = useMemo<ResolvedColumn[] | null>(() => {
    if (!columns || columns.length === 0) return null;
    return groupIssuesIntoColumns(issues, columns);
  }, [issues, columns]);

  const useColumnView = columnGroups !== null;

  return (
    <div className="mb-6 rounded-[10px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[var(--color-border-subtle)]">
        <div className="flex items-center gap-2">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
            Backlog
          </h2>
          {labelParam && (
            <span className="rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 font-[var(--font-mono)] text-[10px] text-[var(--color-text-muted)]">
              {labelParam}
            </span>
          )}
          {polled && (
            <span className="text-[11px] text-[var(--color-text-tertiary)]">
              {issues.length} issue{issues.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handlePoll();
            }}
            placeholder="Assignee"
            className="h-[28px] rounded-[6px] border border-[var(--color-border-default)] bg-transparent px-2.5 text-[11px] text-[var(--color-text-secondary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none w-[120px]"
          />
          <button
            type="button"
            onClick={() => void handlePoll()}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-[6px] border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-wait disabled:opacity-60"
          >
            {loading ? (
              <>
                <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="3"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                Polling...
              </>
            ) : (
              <>
                <svg
                  className="h-3 w-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Poll for new tasks
              </>
            )}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-2.5 text-[11px] text-[var(--color-status-error)]">{error}</div>
      )}

      {/* Empty state */}
      {polled && issues.length === 0 && !error && (
        <div className="px-4 py-3 text-[11px] text-[var(--color-text-muted)]">
          No matching issues found.
        </div>
      )}

      {/* Column view */}
      {useColumnView && issues.length > 0 && columnGroups && (
        <div className="flex gap-0 overflow-x-auto divide-x divide-[var(--color-border-subtle)]">
          {columnGroups.map((col) => (
            <div key={col.label} className="min-w-[220px] flex-1">
              {/* Column header */}
              <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--color-border-subtle)]">
                <span className="text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
                  {col.label}
                </span>
                <span className="rounded-full bg-[var(--color-bg-muted)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                  {col.issues.length}
                </span>
              </div>
              {/* Column issues */}
              {col.issues.length === 0 ? (
                <div className="px-4 py-3 text-[11px] text-[var(--color-text-muted)] italic">
                  No issues
                </div>
              ) : (
                <ul className="divide-y divide-[var(--color-border-subtle)]">
                  {col.issues.map((issue) => (
                    <IssueRow
                      key={issue.id}
                      issue={issue}
                      spawning={!!spawning[issue.id]}
                      spawned={spawnedIds.has(issue.id)}
                      spawnError={spawnErrors[issue.id]}
                      onSpawn={() => void handleSpawn(issue)}
                    />
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Flat list view (no columns configured) */}
      {!useColumnView && issues.length > 0 && (
        <ul className="divide-y divide-[var(--color-border-subtle)]">
          {issues.map((issue) => (
            <IssueRow
              key={issue.id}
              issue={issue}
              spawning={!!spawning[issue.id]}
              spawned={spawnedIds.has(issue.id)}
              spawnError={spawnErrors[issue.id]}
              onSpawn={() => void handleSpawn(issue)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// IssueRow
// ---------------------------------------------------------------------------

function IssueRow({
  issue,
  spawning,
  spawned,
  spawnError,
  onSpawn,
}: {
  issue: BacklogIssue;
  spawning: boolean;
  spawned: boolean;
  spawnError?: string;
  onSpawn: () => void;
}) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <a
          href={issue.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-[13px] font-medium text-[var(--color-text-primary)] hover:text-[var(--color-accent)] hover:underline"
        >
          {issue.title}
        </a>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="font-[var(--font-mono)] text-[10px] text-[var(--color-text-muted)]">
            #{issue.id}
          </span>
          {issue.issueType && <IssueTypeBadge type={issue.issueType} />}
          {issue.statusName && <StatusPill status={issue.statusName} state={issue.state} />}
          {issue.assignee && (
            <span className="text-[10px] text-[var(--color-text-muted)]">@{issue.assignee}</span>
          )}
          {issue.labels.map((label) => (
            <span
              key={label}
              className="rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
            >
              {label}
            </span>
          ))}
        </div>
        {spawnError && (
          <p className="mt-1 text-[11px] text-[var(--color-status-error)]">{spawnError}</p>
        )}
      </div>

      {spawned ? (
        <span className="mt-0.5 shrink-0 text-[11px] text-[var(--color-status-ready)]">
          agent started
        </span>
      ) : (
        <button
          type="button"
          onClick={onSpawn}
          disabled={spawning}
          className="mt-0.5 shrink-0 rounded-[6px] border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-wait disabled:opacity-60"
        >
          {spawning ? "Starting..." : "Start agent"}
        </button>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function IssueTypeBadge({ type }: { type: string }) {
  const lower = type.toLowerCase();
  let color = "text-[var(--color-text-muted)] border-[var(--color-border-subtle)]";
  if (lower === "bug") color = "text-[#f87171] border-[#f87171]/30 bg-[#f87171]/10";
  else if (lower === "story" || lower === "user story")
    color = "text-[#a78bfa] border-[#a78bfa]/30 bg-[#a78bfa]/10";
  else if (lower === "task") color = "text-[#60a5fa] border-[#60a5fa]/30 bg-[#60a5fa]/10";
  else if (lower === "epic") color = "text-[#f59e0b] border-[#f59e0b]/30 bg-[#f59e0b]/10";
  else if (lower === "subtask" || lower === "sub-task")
    color = "text-[var(--color-text-secondary)] border-[var(--color-border-subtle)]";

  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${color}`}>{type}</span>
  );
}

function StatusPill({ status, state }: { status: string; state: string }) {
  let color = "text-[var(--color-text-muted)] border-[var(--color-border-subtle)]";
  if (state === "in_progress") color = "text-[#fbbf24] border-[#fbbf24]/30 bg-[#fbbf24]/10";
  else if (state === "open")
    color = "text-[var(--color-text-secondary)] border-[var(--color-border-subtle)]";
  else if (state === "closed") color = "text-[#4ade80] border-[#4ade80]/30 bg-[#4ade80]/10";

  return <span className={`rounded border px-1.5 py-0.5 text-[10px] ${color}`}>{status}</span>;
}

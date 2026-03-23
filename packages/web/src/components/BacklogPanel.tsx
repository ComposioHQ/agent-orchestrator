"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import type { ColumnConfig } from "@/lib/project-name";

export interface BacklogIssue {
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

/** Serialisable state that Dashboard caches per-project. */
export interface BacklogState {
  issues: BacklogIssue[];
  polled: boolean;
  assigneeFilter: string;
}

interface BacklogPanelProps {
  projectId: string;
  triggerLabels?: string[];
  /** Default assignee filter from project config (tracker.trigger.assignee) */
  triggerAssignee?: string;
  columns?: ColumnConfig[];
  /** Previously cached state for this project (survives project navigation). */
  cachedState?: BacklogState;
  /** Called whenever panel state changes so the parent can persist it. */
  onStateChange?: (projectId: string, state: BacklogState) => void;
}

// ---------------------------------------------------------------------------
// Column grouping logic
// ---------------------------------------------------------------------------

interface ResolvedColumn {
  label: string;
  dot: string;
  badge: string;
  issues: BacklogIssue[];
}

const DEFAULT_COLUMN_STYLES = [
  { dot: "bg-slate-400", badge: "bg-slate-100 text-slate-600" },
  { dot: "bg-purple-500", badge: "bg-purple-100 text-purple-700" },
  { dot: "bg-indigo-500", badge: "bg-indigo-100 text-indigo-700" },
  { dot: "bg-amber-500", badge: "bg-amber-100 text-amber-700" },
  { dot: "bg-green-500", badge: "bg-emerald-100 text-emerald-700" },
];

function groupIssuesIntoColumns(issues: BacklogIssue[], columns: ColumnConfig[]): ResolvedColumn[] {
  const assigned = new Set<string>();
  const namedColumns: ResolvedColumn[] = columns.map((col, i) => {
    const style = DEFAULT_COLUMN_STYLES[i % DEFAULT_COLUMN_STYLES.length];
    const matched = issues.filter((issue) => {
      if (!col.statuses || col.statuses.length === 0) return false;
      return col.statuses.includes(issue.statusName ?? "");
    });
    matched.forEach((issue) => assigned.add(issue.id));
    return { label: col.label, dot: style.dot, badge: style.badge, issues: matched };
  });

  const other = issues.filter((i) => !assigned.has(i.id));
  if (other.length > 0) {
    return [
      { label: "Other", dot: "bg-slate-400", badge: "bg-slate-100 text-slate-600", issues: other },
      ...namedColumns,
    ];
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
  cachedState,
  onStateChange,
}: BacklogPanelProps) {
  const [issues, setIssues] = useState<BacklogIssue[]>(cachedState?.issues ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spawning, setSpawning] = useState<Record<string, boolean>>({});
  const [spawnedIds, setSpawnedIds] = useState<Set<string>>(new Set());
  const [spawnErrors, setSpawnErrors] = useState<Record<string, string>>({});
  const [polled, setPolled] = useState(cachedState?.polled ?? false);
  const [assigneeFilter, setAssigneeFilter] = useState(
    cachedState?.assigneeFilter ?? triggerAssignee ?? "",
  );

  const labelParam = triggerLabels?.[0];

  // When the active project changes, reset local state to whatever is cached
  // for the new project (or to empty if it has never been fetched).
  useEffect(() => {
    setIssues(cachedState?.issues ?? []);
    setPolled(cachedState?.polled ?? false);
    setAssigneeFilter(cachedState?.assigneeFilter ?? triggerAssignee ?? "");
    setError(null);
    setSpawning({});
    setSpawnedIds(new Set());
    setSpawnErrors({});
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

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
      onStateChange?.(projectId, { issues: data.issues, polled: true, assigneeFilter });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch issues");
    } finally {
      setLoading(false);
    }
  }, [projectId, labelParam, assigneeFilter, onStateChange]);

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

  // Build column groups — either from config or a single flat "Backlog" column
  const columnGroups = useMemo<ResolvedColumn[]>(() => {
    if (columns && columns.length > 0) {
      return groupIssuesIntoColumns(issues, columns);
    }
    // No column config: single column containing all issues
    return [
      {
        label: "Backlog",
        dot: "bg-slate-400",
        badge: "bg-slate-100 text-slate-600",
        issues,
      },
    ];
  }, [issues, columns]);

  const hasIssues = issues.length > 0;

  return (
    <div className="mb-6">
      {/* Header bar */}
      <div className="mb-3 flex items-center justify-between gap-3">
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
            onChange={(e) => {
              const next = e.target.value;
              setAssigneeFilter(next);
              onStateChange?.(projectId, { issues, polled, assigneeFilter: next });
            }}
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
              </>
            )}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-3 rounded-[6px] border border-[rgba(239,68,68,0.25)] bg-[rgba(239,68,68,0.05)] px-3.5 py-2.5 text-[11px] text-[var(--color-status-error)]">
          {error}
        </div>
      )}

      {/* Empty state after poll */}
      {polled && !hasIssues && !error && (
        <div className="rounded-[10px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-4 py-6 text-center text-[11px] text-[var(--color-text-muted)]">
          No matching issues found.
        </div>
      )}

      {/* Pre-poll empty state */}
      {!polled && !error && (
        <div className="rounded-[10px] border border-dashed border-[var(--color-border-subtle)] px-4 py-6 text-center text-[11px] text-[var(--color-text-muted)]">
          Click &ldquo;Poll for new tasks&rdquo; to load issues.
        </div>
      )}

      {/* Kanban columns */}
      {hasIssues && (
        <div className="grid grid-cols-1 gap-4 overflow-x-auto pb-2 sm:grid-flow-col sm:auto-cols-[minmax(280px,340px)] sm:grid-cols-none">
          {columnGroups.map((col) => (
            <KanbanColumn
              key={col.label}
              column={col}
              spawning={spawning}
              spawnedIds={spawnedIds}
              spawnErrors={spawnErrors}
              onSpawn={handleSpawn}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KanbanColumn
// ---------------------------------------------------------------------------

function KanbanColumn({
  column,
  spawning,
  spawnedIds,
  spawnErrors,
  onSpawn,
}: {
  column: ResolvedColumn;
  spawning: Record<string, boolean>;
  spawnedIds: Set<string>;
  spawnErrors: Record<string, string>;
  onSpawn: (issue: BacklogIssue) => void;
}) {
  return (
    <div className="flex flex-col min-h-0">
      {/* Sticky column header */}
      <div className="sticky top-0 z-10 rounded-t-[10px] border border-b-0 border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${column.dot}`} />
            <h3 className="text-[12px] font-semibold text-[var(--color-text-primary)]">
              {column.label}
            </h3>
          </div>
          <span
            className={`flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold ${column.badge}`}
          >
            {column.issues.length}
          </span>
        </div>
      </div>

      {/* Cards container */}
      <div className="rounded-b-[10px] border border-t-0 border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-3">
        {column.issues.length === 0 ? (
          <p className="py-4 text-center text-[11px] italic text-[var(--color-text-muted)]">
            No issues
          </p>
        ) : (
          <div className="space-y-2">
            {column.issues.map((issue) => (
              <IssueCard
                key={issue.id}
                issue={issue}
                spawning={!!spawning[issue.id]}
                spawned={spawnedIds.has(issue.id)}
                spawnError={spawnErrors[issue.id]}
                onSpawn={() => onSpawn(issue)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IssueCard
// ---------------------------------------------------------------------------

function IssueCard({
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
    <div className="group relative rounded-[8px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] p-3 shadow-sm transition-all hover:-translate-y-px hover:border-[var(--color-border-default)] hover:shadow-md">
      {/* Issue title */}
      <a
        href={issue.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block text-[13px] font-medium leading-snug text-[var(--color-text-primary)] hover:text-[var(--color-accent)] hover:underline line-clamp-2"
      >
        {issue.title}
      </a>

      {/* Meta row */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="font-[var(--font-mono)] text-[10px] text-[var(--color-text-muted)]">
          #{issue.id}
        </span>
        {issue.issueType && <IssueTypeBadge type={issue.issueType} />}
        {issue.statusName && <StatusPill status={issue.statusName} state={issue.state} />}
        {issue.assignee && (
          <span className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
            {/* person icon */}
            <svg
              className="h-3 w-3 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            {issue.assignee}
          </span>
        )}
        {issue.labels.map((label) => (
          <span
            key={label}
            className="rounded-full border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
          >
            {label}
          </span>
        ))}
      </div>

      {/* Spawn error */}
      {spawnError && (
        <p className="mt-1.5 text-[11px] text-[var(--color-status-error)]">{spawnError}</p>
      )}

      {/* Footer: spawn action */}
      <div className="mt-3 flex items-center justify-end border-t border-[var(--color-border-subtle)] pt-2.5">
        {spawned ? (
          <span className="flex items-center gap-1 text-[11px] text-[var(--color-status-ready)]">
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
            agent started
          </span>
        ) : (
          <button
            type="button"
            onClick={onSpawn}
            disabled={spawning}
            className="rounded-[6px] border border-[var(--color-border-default)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-wait disabled:opacity-60"
          >
            {spawning ? "Starting..." : "Start agent"}
          </button>
        )}
      </div>
    </div>
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

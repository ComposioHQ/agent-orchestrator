"use client";

import { useState, useCallback } from "react";

interface BacklogIssue {
  projectId: string;
  id: string;
  title: string;
  url: string;
  state: string;
  labels: string[];
  issueType?: string;
  statusName?: string;
}

interface BacklogPanelProps {
  projectId: string;
  triggerLabels?: string[];
}

export function BacklogPanel({ projectId, triggerLabels }: BacklogPanelProps) {
  const [issues, setIssues] = useState<BacklogIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spawning, setSpawning] = useState<Record<string, boolean>>({});
  const [spawnedIds, setSpawnedIds] = useState<Set<string>>(new Set());
  const [spawnErrors, setSpawnErrors] = useState<Record<string, string>>({});
  const [polled, setPolled] = useState(false);

  const labelParam = triggerLabels?.[0];

  const handlePoll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ project: projectId, state: "open" });
      if (labelParam) params.set("label", labelParam);
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
  }, [projectId, labelParam]);

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

  return (
    <div className="mb-6 rounded-[10px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]">
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
        <button
          type="button"
          onClick={() => void handlePoll()}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-[6px] border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-wait disabled:opacity-60"
        >
          {loading ? (
            <>
              <svg
                className="h-3 w-3 animate-spin"
                fill="none"
                viewBox="0 0 24 24"
              >
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

      {error && (
        <div className="px-4 py-2.5 text-[11px] text-[var(--color-status-error)]">
          {error}
        </div>
      )}

      {polled && issues.length === 0 && !error && (
        <div className="px-4 py-3 text-[11px] text-[var(--color-text-muted)]">
          No matching issues found.
        </div>
      )}

      {issues.length > 0 && (
        <ul className="divide-y divide-[var(--color-border-subtle)]">
          {issues.map((issue) => (
            <li key={issue.id} className="flex items-start gap-3 px-4 py-3">
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
                  {issue.issueType && (
                    <IssueTypeBadge type={issue.issueType} />
                  )}
                  {issue.statusName && (
                    <StatusPill status={issue.statusName} state={issue.state} />
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
                {spawnErrors[issue.id] && (
                  <p className="mt-1 text-[11px] text-[var(--color-status-error)]">
                    {spawnErrors[issue.id]}
                  </p>
                )}
              </div>

              {spawnedIds.has(issue.id) ? (
                <span className="mt-0.5 shrink-0 text-[11px] text-[var(--color-status-ready)]">
                  agent started
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleSpawn(issue)}
                  disabled={!!spawning[issue.id]}
                  className="mt-0.5 shrink-0 rounded-[6px] border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-wait disabled:opacity-60"
                >
                  {spawning[issue.id] ? "Starting..." : "Start agent"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
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
  else if (lower === "story" || lower === "user story") color = "text-[#a78bfa] border-[#a78bfa]/30 bg-[#a78bfa]/10";
  else if (lower === "task") color = "text-[#60a5fa] border-[#60a5fa]/30 bg-[#60a5fa]/10";
  else if (lower === "epic") color = "text-[#f59e0b] border-[#f59e0b]/30 bg-[#f59e0b]/10";
  else if (lower === "subtask" || lower === "sub-task") color = "text-[var(--color-text-secondary)] border-[var(--color-border-subtle)]";

  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${color}`}>
      {type}
    </span>
  );
}

function StatusPill({ status, state }: { status: string; state: string }) {
  let color = "text-[var(--color-text-muted)] border-[var(--color-border-subtle)]";
  if (state === "in_progress") color = "text-[#fbbf24] border-[#fbbf24]/30 bg-[#fbbf24]/10";
  else if (state === "open") color = "text-[var(--color-text-secondary)] border-[var(--color-border-subtle)]";
  else if (state === "closed") color = "text-[#4ade80] border-[#4ade80]/30 bg-[#4ade80]/10";

  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] ${color}`}>
      {status}
    </span>
  );
}

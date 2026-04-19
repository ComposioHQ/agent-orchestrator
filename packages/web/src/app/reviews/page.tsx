/**
 * Review Workbench — surfaces AI reviewer findings per run, per worker.
 *
 * Server-rendered: pulls review runs via the review manager, groups them by
 * loop state into the 5 columns defined by the spec (RUNNING, AWAITING CONTEXT,
 * DONE, STALLED, TERMINATED).
 *
 * The page is intentionally minimal — it gives a human a clear place to triage
 * without pulling in any new UI dependencies. Dismissal/send actions are done
 * via the PATCH /api/reviews/findings/[runId]/[findingId] endpoint; those
 * require a proper client component to be wired up later.
 */

import { getServices } from "@/lib/services";
import type {
  CodeReviewFinding,
  CodeReviewLoopState,
  CodeReviewRun,
} from "@aoagents/ao-core";

interface EnrichedRun extends CodeReviewRun {
  projectId: string;
  findings: CodeReviewFinding[];
}

const COLUMNS: Array<{ state: CodeReviewLoopState; label: string }> = [
  { state: "reviewing", label: "Running" },
  { state: "awaiting_context", label: "Awaiting context" },
  { state: "done", label: "Done" },
  { state: "stalled", label: "Stalled" },
  { state: "terminated", label: "Terminated" },
];

function severityClass(severity: string): string {
  if (severity === "error") return "text-red-400";
  if (severity === "warning") return "text-amber-400";
  return "text-slate-400";
}

function statusClass(status: string): string {
  if (status === "open") return "text-cyan-400";
  if (status === "dismissed") return "text-slate-500 line-through";
  if (status === "sent_to_agent") return "text-yellow-400";
  return "text-slate-400";
}

async function loadRuns(): Promise<EnrichedRun[]> {
  const { config, reviewManager } = await getServices();
  const runs: EnrichedRun[] = [];
  for (const projectId of Object.keys(config.projects)) {
    let store;
    try {
      store = reviewManager.getStore(projectId);
    } catch {
      continue;
    }
    for (const run of store.listAllRuns()) {
      runs.push({ ...run, projectId, findings: store.listFindingsForRun(run.runId) });
    }
  }
  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return runs;
}

export default async function ReviewsPage(): Promise<React.JSX.Element> {
  const runs = await loadRuns();
  const byColumn = new Map<CodeReviewLoopState, EnrichedRun[]>();
  for (const col of COLUMNS) byColumn.set(col.state, []);
  for (const run of runs) {
    const bucket = byColumn.get(run.loopState);
    if (bucket) bucket.push(run);
  }

  return (
    <main className="p-6 min-h-screen bg-[var(--color-bg)] text-[var(--color-fg)]">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Review Workbench</h1>
        <div className="text-sm text-[var(--color-muted-fg)]">
          {runs.length} run{runs.length === 1 ? "" : "s"}
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {COLUMNS.map((col) => {
          const bucket = byColumn.get(col.state) ?? [];
          return (
            <section
              key={col.state}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
            >
              <h2 className="text-xs uppercase tracking-wide font-semibold mb-3 text-[var(--color-muted-fg)]">
                {col.label} ({bucket.length})
              </h2>
              <ul className="flex flex-col gap-3">
                {bucket.map((run) => (
                  <li
                    key={run.runId}
                    className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg)] p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-[var(--color-fg)]">
                        {run.reviewerSessionId}
                      </span>
                      <code className="text-xs text-[var(--color-muted-fg)]">
                        {run.headSha.slice(0, 7)}
                      </code>
                    </div>
                    <div className="text-xs text-[var(--color-muted-fg)]">
                      {run.projectId} / {run.linkedSessionId}
                    </div>
                    {run.terminationReason ? (
                      <div className="text-xs mt-1 text-amber-400">
                        {run.terminationReason}
                      </div>
                    ) : null}
                    <div className="text-xs mt-2 text-[var(--color-muted-fg)]">
                      {run.findingCount} finding{run.findingCount === 1 ? "" : "s"}
                    </div>
                    {run.findings.length > 0 ? (
                      <ul className="mt-2 flex flex-col gap-1 text-xs">
                        {run.findings.slice(0, 5).map((f) => (
                          <li
                            key={f.findingId}
                            className="flex items-start gap-2 truncate"
                          >
                            <span className={severityClass(f.severity)}>
                              {f.severity.toUpperCase()[0]}
                            </span>
                            <span className={statusClass(f.status)} title={f.title}>
                              {f.filePath}:{f.startLine}
                            </span>
                          </li>
                        ))}
                        {run.findings.length > 5 ? (
                          <li className="text-[var(--color-muted-fg)]">
                            + {run.findings.length - 5} more
                          </li>
                        ) : null}
                      </ul>
                    ) : null}
                  </li>
                ))}
                {bucket.length === 0 ? (
                  <li className="text-xs text-[var(--color-muted-fg)]">No runs.</li>
                ) : null}
              </ul>
            </section>
          );
        })}
      </div>
    </main>
  );
}

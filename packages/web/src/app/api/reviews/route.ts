/**
 * GET /api/reviews — list review runs with findings, grouped by worker session.
 *
 * Query params:
 *   ?project=<id>    filter to a specific project
 *   ?session=<id>    filter to a specific worker session
 */

import { getServices } from "@/lib/services";
import type { CodeReviewRun, CodeReviewFinding } from "@aoagents/ao-core";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const projectFilter = searchParams.get("project");
  const sessionFilter = searchParams.get("session");

  const { config, reviewManager } = await getServices();
  const projectIds = projectFilter
    ? [projectFilter].filter((id) => config.projects[id])
    : Object.keys(config.projects);

  const runs: Array<
    CodeReviewRun & { findings: CodeReviewFinding[]; projectId: string }
  > = [];

  for (const projectId of projectIds) {
    let store;
    try {
      store = reviewManager.getStore(projectId);
    } catch {
      continue;
    }
    const projectRuns = sessionFilter
      ? store.listRunsForSession(sessionFilter)
      : store.listAllRuns();
    for (const run of projectRuns) {
      const findings = store.listFindingsForRun(run.runId);
      runs.push({ ...run, findings, projectId });
    }
  }

  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return Response.json({ runs });
}

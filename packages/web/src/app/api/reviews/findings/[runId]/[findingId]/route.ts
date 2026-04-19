/**
 * PATCH /api/reviews/findings/[runId]/[findingId]
 *
 * Body: { action: "dismiss" | "reopen" | "send", dismissedBy?: string }
 *
 * - dismiss: marks the finding dismissed (human triage); dismissals persist via
 *   fingerprint across future reviewer runs.
 * - reopen: clears dismissal.
 * - send: delivers this finding to the worker's coding agent via the session
 *   manager's send() and marks the finding as sent_to_agent.
 */

import { getServices } from "@/lib/services";

interface PatchBody {
  action?: "dismiss" | "reopen" | "send";
  dismissedBy?: string;
  projectId?: string;
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ runId: string; findingId: string }> },
): Promise<Response> {
  const { runId, findingId } = await ctx.params;
  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.action) {
    return Response.json({ error: "action is required" }, { status: 400 });
  }

  const { config, reviewManager, sessionManager } = await getServices();
  const projectIds = body.projectId ? [body.projectId] : Object.keys(config.projects);

  for (const projectId of projectIds) {
    let store;
    try {
      store = reviewManager.getStore(projectId);
    } catch {
      continue;
    }
    const run = store.getRun(runId);
    if (!run) continue;

    try {
      if (body.action === "dismiss") {
        const finding = await reviewManager.dismissFinding({
          projectId,
          runId,
          findingId,
          dismissedBy: body.dismissedBy ?? "operator",
        });
        return Response.json({ finding });
      }
      if (body.action === "reopen") {
        const finding = await reviewManager.reopenFinding({ projectId, runId, findingId });
        return Response.json({ finding });
      }
      if (body.action === "send") {
        const finding = store.getFinding(runId, findingId);
        if (!finding) {
          return Response.json({ error: `Finding not found` }, { status: 404 });
        }
        const message = [
          `Code review finding on your PR:`,
          ``,
          `- [${finding.severity.toUpperCase()}] ${finding.filePath}:${finding.startLine}-${finding.endLine} — ${finding.title}`,
          `    ${finding.description.split("\n").join("\n    ")}`,
          ``,
          `Please address it, push a fix, and reply.`,
        ].join("\n");

        await sessionManager.send(run.linkedSessionId, message);
        const [updated] = await reviewManager.markSentToAgent({
          projectId,
          runId,
          findingIds: [findingId],
        });
        return Response.json({ finding: updated });
      }
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
    return Response.json({ error: `Unknown action: ${body.action}` }, { status: 400 });
  }

  return Response.json({ error: `Run not found: ${runId}` }, { status: 404 });
}

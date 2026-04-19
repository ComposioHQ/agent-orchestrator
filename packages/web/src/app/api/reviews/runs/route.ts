/**
 * POST /api/reviews/runs — manually trigger a review for a worker session.
 *
 * Body: { sessionId: string, projectId?: string, baseBranch?: string }
 */

import { getServices } from "@/lib/services";

interface TriggerBody {
  sessionId?: string;
  projectId?: string;
  baseBranch?: string;
}

export async function POST(request: Request): Promise<Response> {
  let body: TriggerBody;
  try {
    body = (await request.json()) as TriggerBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.sessionId) {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }

  const { config, sessionManager, reviewManager } = await getServices();
  const session = await sessionManager.get(body.sessionId);
  if (!session) {
    return Response.json({ error: `Session not found: ${body.sessionId}` }, { status: 404 });
  }
  if (!session.workspacePath) {
    return Response.json(
      { error: `Session ${body.sessionId} has no workspace path` },
      { status: 400 },
    );
  }

  const projectId = body.projectId ?? session.projectId;
  const project = config.projects[projectId];
  if (!project) {
    return Response.json({ error: `Project not found: ${projectId}` }, { status: 404 });
  }
  if (!project.codeReview?.plugin) {
    return Response.json(
      { error: `Project ${projectId} has no codeReview.plugin configured` },
      { status: 400 },
    );
  }

  try {
    const run = await reviewManager.triggerReview({
      projectId,
      linkedSessionId: body.sessionId,
      workerWorkspacePath: session.workspacePath,
      branch: session.branch ?? project.defaultBranch,
      baseBranch: body.baseBranch ?? project.defaultBranch,
    });
    return Response.json({ run });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

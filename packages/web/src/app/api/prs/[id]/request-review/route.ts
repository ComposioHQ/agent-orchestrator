import { type NextRequest } from "next/server";
import { getServices, getSCM } from "@/lib/services";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";

/** POST /api/prs/:id/request-review — Request reviewers on a PR */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(_request);
  const startedAt = Date.now();
  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return jsonWithCorrelation({ error: "Invalid PR number" }, { status: 400 }, correlationId);
  }
  const prNumber = Number(id);

  try {
    const { config, registry, sessionManager } = await getServices();
    const sessions = await sessionManager.list();

    const session = sessions.find((s) => s.pr?.number === prNumber);
    if (!session?.pr) {
      return jsonWithCorrelation({ error: "PR not found" }, { status: 404 }, correlationId);
    }

    const project = config.projects[session.projectId];
    const scm = getSCM(registry, project);
    if (!scm) {
      return jsonWithCorrelation(
        { error: "No SCM plugin configured for this project" },
        { status: 500 },
        correlationId,
      );
    }

    if (!scm.requestReviewers) {
      return jsonWithCorrelation(
        { error: "SCM plugin does not support requesting reviewers" },
        { status: 501 },
        correlationId,
      );
    }

    const reviewers = project.defaultReviewers;
    if (!reviewers || reviewers.length === 0) {
      return jsonWithCorrelation(
        { error: "No defaultReviewers configured for this project" },
        { status: 422 },
        correlationId,
      );
    }

    await scm.requestReviewers(session.pr, reviewers);
    recordApiObservation({
      config,
      method: "POST",
      path: "/api/prs/[id]/request-review",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId: session.projectId,
      sessionId: session.id,
      data: { prNumber, reviewers },
    });
    return jsonWithCorrelation(
      { ok: true, prNumber, reviewers },
      { status: 200 },
      correlationId,
    );
  } catch (err) {
    const { config } = await getServices().catch(() => ({ config: undefined }));
    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/prs/[id]/request-review",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        reason: err instanceof Error ? err.message : "Failed to request reviewers",
        data: { prNumber },
      });
    }
    return jsonWithCorrelation(
      { error: err instanceof Error ? err.message : "Failed to request reviewers" },
      { status: 500 },
      correlationId,
    );
  }
}

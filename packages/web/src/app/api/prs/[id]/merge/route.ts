import { type NextRequest } from "next/server";
import { getServices, getSCM } from "@/lib/services";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";

/** POST /api/prs/:id/merge — Merge a PR */
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

    // Validate PR is in a mergeable state
    const state = await scm.getPRState(session.pr);
    if (state !== "open") {
      return jsonWithCorrelation(
        { error: `PR is ${state}, not open` },
        { status: 409 },
        correlationId,
      );
    }

    const mergeability = await scm.getMergeability(session.pr);
    if (!mergeability.mergeable) {
      return jsonWithCorrelation(
        { error: "PR is not mergeable", blockers: mergeability.blockers },
        { status: 422 },
        correlationId,
      );
    }

    await scm.mergePR(session.pr, "squash");
    recordApiObservation({
      config,
      method: "POST",
      path: "/api/prs/[id]/merge",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId: session.projectId,
      sessionId: session.id,
      data: { prNumber },
    });
    return jsonWithCorrelation(
      { ok: true, prNumber, method: "squash" },
      { status: 200 },
      correlationId,
    );
  } catch (err) {
    const { config } = await getServices().catch(() => ({ config: undefined }));
    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/prs/[id]/merge",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        reason: err instanceof Error ? err.message : "Failed to merge PR",
        data: { prNumber },
      });
    }
    return jsonWithCorrelation(
      { error: err instanceof Error ? err.message : "Failed to merge PR" },
      { status: 500 },
      correlationId,
    );
  }
}

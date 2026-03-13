import type { SCM } from "@composio/ao-core";
import { type NextRequest } from "next/server";
import { getSCM, getServices } from "@/lib/services";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import {
  REVIEW_INTEGRITY_DEFAULTS,
  getReviewResolutionStore,
  getThreadSnapshots,
} from "@/lib/review-integrity";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(_request);
  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return jsonWithCorrelation({ error: "Invalid PR number" }, { status: 400 }, correlationId);
  }
  const prNumber = Number(id);

  let body: unknown;
  try {
    body = await _request.json();
  } catch {
    return jsonWithCorrelation({ error: "Invalid JSON body" }, { status: 400 }, correlationId);
  }

  const payload = body as { threadId?: string };
  if (!payload.threadId) {
    return jsonWithCorrelation({ error: "threadId is required" }, { status: 400 }, correlationId);
  }

  const { config, registry, sessionManager } = await getServices();
  const sessions = await sessionManager.list();
  const session = sessions.find((s) => s.pr?.number === prNumber);
  if (!session?.pr) {
    return jsonWithCorrelation({ error: "PR not found" }, { status: 404 }, correlationId);
  }

  const project = config.projects[session.projectId];
  const scm = getSCM(registry, project) as SCM | null;
  if (!scm) {
    return jsonWithCorrelation(
      { error: "No SCM plugin configured for this project" },
      { status: 500 },
      correlationId,
    );
  }

  const store = getReviewResolutionStore(config, project);
  const latest = store.latestByThread(prNumber).get(payload.threadId);
  if (!latest) {
    return jsonWithCorrelation(
      { error: "Resolution record not found" },
      { status: 404 },
      correlationId,
    );
  }

  if (latest.verificationStatus !== "pass") {
    return jsonWithCorrelation(
      {
        error: "Resolution must be verified before apply",
        verificationStatus: latest.verificationStatus,
      },
      { status: 422 },
      correlationId,
    );
  }

  if (REVIEW_INTEGRITY_DEFAULTS.reverifyOnNewCommits && scm.getPRHeadSha) {
    const currentHeadSha = await scm.getPRHeadSha(session.pr);
    if (!latest.verifiedHeadSha || latest.verifiedHeadSha !== currentHeadSha) {
      return jsonWithCorrelation(
        {
          error: "Resolution verification is stale; re-verify required",
          verifiedHeadSha: latest.verifiedHeadSha ?? null,
          currentHeadSha,
        },
        { status: 422 },
        correlationId,
      );
    }
  }

  if (!scm.getReviewThreadSnapshots) {
    return jsonWithCorrelation(
      {
        error: "SCM does not support full review thread snapshots",
        blockers: [
          {
            code: "THREAD_SNAPSHOTS_UNAVAILABLE",
            message: "SCM does not support full review thread snapshots",
          },
        ],
      },
      { status: 422 },
      correlationId,
    );
  }

  const threads = await getThreadSnapshots(scm, session.pr);
  if (!threads.some((thread) => thread.threadId === payload.threadId)) {
    return jsonWithCorrelation(
      { error: "Review thread not found on PR" },
      { status: 422 },
      correlationId,
    );
  }

  if (scm.resolveReviewThread) {
    await scm.resolveReviewThread(session.pr, payload.threadId);
  }

  const { id: _id, createdAt: _createdAt, ...base } = latest;
  const applied = store.persist({
    ...base,
    appliedAt: new Date(),
  });

  return jsonWithCorrelation(
    {
      ok: true,
      resolution: {
        ...applied,
        createdAt: applied.createdAt.toISOString(),
        appliedAt: applied.appliedAt?.toISOString(),
      },
    },
    { status: 200 },
    correlationId,
  );
}

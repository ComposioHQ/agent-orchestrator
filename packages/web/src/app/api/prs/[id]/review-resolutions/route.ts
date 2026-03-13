import { type NextRequest } from "next/server";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { getServices } from "@/lib/services";
import {
  REVIEW_INTEGRITY_DEFAULTS,
  buildResolutionRecordInput,
  getReviewResolutionStore,
} from "@/lib/review-integrity";

const RESOLUTION_TYPES = ["fixed", "already_fixed", "not_actionable", "duplicate"] as const;

function isResolutionType(value: unknown): value is (typeof RESOLUTION_TYPES)[number] {
  return (
    typeof value === "string" &&
    RESOLUTION_TYPES.includes(value as (typeof RESOLUTION_TYPES)[number])
  );
}

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

  const payload = body as {
    threadId?: string;
    resolutionType?: unknown;
    actorId?: string;
    fixCommitSha?: string;
    rationale?: string;
    evidence?: {
      changedFiles?: string[];
      testCommands?: string[];
      testResults?: string[];
    };
  };

  if (!payload.threadId) {
    return jsonWithCorrelation({ error: "threadId is required" }, { status: 400 }, correlationId);
  }
  if (!payload.resolutionType) {
    return jsonWithCorrelation(
      { error: "resolutionType is required" },
      { status: 400 },
      correlationId,
    );
  }
  if (!isResolutionType(payload.resolutionType)) {
    return jsonWithCorrelation(
      { error: `resolutionType must be one of: ${RESOLUTION_TYPES.join(", ")}` },
      { status: 400 },
      correlationId,
    );
  }

  const { config, sessionManager } = await getServices();
  const sessions = await sessionManager.list();
  const session = sessions.find((s) => s.pr?.number === prNumber);
  if (!session?.pr) {
    return jsonWithCorrelation({ error: "PR not found" }, { status: 404 }, correlationId);
  }

  const project = config.projects[session.projectId];
  const store = getReviewResolutionStore(config, project);

  const created = store.persist(
    buildResolutionRecordInput({
      prNumber,
      threadId: payload.threadId,
      resolutionType: payload.resolutionType,
      actorId: payload.actorId ?? "ao-web",
      fixCommitSha: payload.fixCommitSha,
      rationale: payload.rationale,
      evidence: payload.evidence,
    }),
  );

  return jsonWithCorrelation(
    {
      ok: true,
      defaults: REVIEW_INTEGRITY_DEFAULTS,
      resolution: {
        ...created,
        createdAt: created.createdAt.toISOString(),
        appliedAt: created.appliedAt?.toISOString(),
      },
    },
    { status: 201 },
    correlationId,
  );
}

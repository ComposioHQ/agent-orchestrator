import type { SCM } from "@composio/ao-core";
import { type NextRequest } from "next/server";
import { getSCM, getServices } from "@/lib/services";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { getThreadSnapshots } from "@/lib/review-integrity";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(_request);
  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return jsonWithCorrelation({ error: "Invalid PR number" }, { status: 400 }, correlationId);
  }

  const prNumber = Number(id);
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

  const threads = await getThreadSnapshots(scm, session.pr);
  return jsonWithCorrelation(
    {
      prNumber,
      threads: threads.map((thread) => ({
        ...thread,
        capturedAt: thread.capturedAt.toISOString(),
      })),
    },
    { status: 200 },
    correlationId,
  );
}

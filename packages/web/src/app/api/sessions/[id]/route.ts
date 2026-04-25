import { type NextRequest } from "next/server";
import { getSessionsDir, readAgentReportAuditTrailAsync } from "@aoagents/ao-core";
import { getServices, getSCM } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionsMetadata,
} from "@/lib/serialize";
import { settlesWithin } from "@/lib/async-utils";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";

const AGENT_REPORT_AUDIT_TIMEOUT_MS = 1000;
const METADATA_ENRICH_TIMEOUT_MS = 3000;
const PR_CACHE_ENRICH_TIMEOUT_MS = 1000;
const PR_LIVE_ENRICH_TIMEOUT_MS = 2000;

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(_request);
  const startedAt = Date.now();
  try {
    const { id } = await params;
    const { config, registry, sessionManager } = await getServices();

    const coreSession = await sessionManager.get(id);
    if (!coreSession) {
      return jsonWithCorrelation({ error: "Session not found" }, { status: 404 }, correlationId);
    }

    const dashboardSession = sessionToDashboard(coreSession);
    const project = resolveProject(coreSession, config.projects);
    if (project?.storageKey) {
      const sessionsDir = getSessionsDir(project.storageKey);
      const auditPromise = readAgentReportAuditTrailAsync(sessionsDir, coreSession.id).then((audit) => {
        dashboardSession.agentReportAudit = audit;
      });
      await settlesWithin(auditPromise, AGENT_REPORT_AUDIT_TIMEOUT_MS);
    }

    // Enrich metadata (issue labels, agent summaries, issue titles)
    await settlesWithin(
      enrichSessionsMetadata([coreSession], [dashboardSession], config, registry),
      METADATA_ENRICH_TIMEOUT_MS,
    );

    // Enrich PR — serve cache immediately, refresh in background if stale
    if (coreSession.pr) {
      const scm = getSCM(registry, project);
      if (scm) {
        let cached = false;
        const cachedSettled = await settlesWithin(
          enrichSessionPR(dashboardSession, scm, coreSession.pr, {
            cacheOnly: true,
          }).then((result) => {
            cached = result;
          }),
          PR_CACHE_ENRICH_TIMEOUT_MS,
        );
        if (!cached) {
          // Nothing cached yet — block once to populate, then future calls use cache
          await settlesWithin(
            enrichSessionPR(dashboardSession, scm, coreSession.pr),
            cachedSettled ? PR_LIVE_ENRICH_TIMEOUT_MS : PR_CACHE_ENRICH_TIMEOUT_MS + PR_LIVE_ENRICH_TIMEOUT_MS,
          );
        }
      }
    }

    recordApiObservation({
      config,
      method: "GET",
      path: "/api/sessions/[id]",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId: coreSession.projectId,
      sessionId: id,
    });

    return jsonWithCorrelation(dashboardSession, { status: 200 }, correlationId);
  } catch (error) {
    const { id } = await params;
    const { config, sessionManager } = await getServices().catch(() => ({
      config: undefined,
      sessionManager: undefined,
    }));
    const session = sessionManager ? await sessionManager.get(id).catch(() => null) : null;
    if (config) {
      recordApiObservation({
        config,
        method: "GET",
        path: "/api/sessions/[id]",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId: session?.projectId,
        sessionId: id,
        reason: error instanceof Error ? error.message : "Internal server error",
      });
    }
    return jsonWithCorrelation({ error: "Internal server error" }, { status: 500 }, correlationId);
  }
}

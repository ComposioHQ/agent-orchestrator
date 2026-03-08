import { ACTIVITY_STATE } from "@composio/ao-core";
import { NextResponse } from "next/server";
import { getServices, getSCM } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionsMetadata,
  computeStats,
} from "@/lib/serialize";

const METADATA_ENRICH_TIMEOUT_MS = 3_000;
const PR_ENRICH_TIMEOUT_MS = 4_000;
const PER_PR_ENRICH_TIMEOUT_MS = 1_500;

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<boolean>((resolve) => {
    timeoutId = setTimeout(() => resolve(false), timeoutMs);
  });

  try {
    return await Promise.race([promise.then(() => true).catch(() => true), timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/** GET /api/sessions — List all sessions with full state
 * Query params:
 * - active=true: Only return non-exited sessions
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get("active") === "true";

    const { config, registry, sessionManager } = await getServices();
    const coreSessions = await sessionManager.list();

    // Find orchestrator session ID (if running) and expose to clients
    const orchSession = coreSessions.find((s) => s.id.endsWith("-orchestrator"));
    const orchestratorId = orchSession ? orchSession.id : null;

    // Filter out orchestrator sessions — they get their own button, not a card
    let workerSessions = coreSessions.filter((s) => !s.id.endsWith("-orchestrator"));

    // Convert to dashboard format
    let dashboardSessions = workerSessions.map(sessionToDashboard);

    // Filter to active sessions only if requested (keep workerSessions in sync)
    if (activeOnly) {
      const activeIndices = dashboardSessions
        .map((s, i) => (s.activity !== ACTIVITY_STATE.EXITED ? i : -1))
        .filter((i) => i !== -1);
      workerSessions = activeIndices.map((i) => workerSessions[i]);
      dashboardSessions = activeIndices.map((i) => dashboardSessions[i]);
    }

    const metadataSettled = await settlesWithin(
      enrichSessionsMetadata(workerSessions, dashboardSessions, config, registry),
      METADATA_ENRICH_TIMEOUT_MS,
    );

    if (metadataSettled) {
      const prDeadlineAt = Date.now() + PR_ENRICH_TIMEOUT_MS;
      for (let i = 0; i < workerSessions.length; i++) {
        const core = workerSessions[i];
        if (!core?.pr) continue;

        const remainingMs = prDeadlineAt - Date.now();
        if (remainingMs <= 0) break;

        const project = resolveProject(core, config.projects);
        const scm = getSCM(registry, project);
        if (!scm) continue;

        await settlesWithin(
          enrichSessionPR(dashboardSessions[i], scm, core.pr),
          Math.min(remainingMs, PER_PR_ENRICH_TIMEOUT_MS),
        );
      }
    }

    return NextResponse.json({
      sessions: dashboardSessions,
      stats: computeStats(dashboardSessions),
      orchestratorId,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list sessions" },
      { status: 500 },
    );
  }
}

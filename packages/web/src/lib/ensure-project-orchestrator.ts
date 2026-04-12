import { generateOrchestratorPrompt, isOrchestratorSession } from "@aoagents/ao-core";
import type { DashboardOrchestratorLink } from "@/lib/types";
import { getServices } from "@/lib/services";
import { listDashboardOrchestrators } from "@/lib/serialize";

const globalForProjectOrchestrator = globalThis as typeof globalThis & {
  _aoEnsureProjectOrchestratorLocks?: Map<string, Promise<DashboardOrchestratorLink | null>>;
};

function getProjectLocks(): Map<string, Promise<DashboardOrchestratorLink | null>> {
  globalForProjectOrchestrator._aoEnsureProjectOrchestratorLocks ??= new Map();
  return globalForProjectOrchestrator._aoEnsureProjectOrchestratorLocks;
}

/**
 * Ensure the canonical per-project orchestrator exists.
 *
 * This is intentionally best-effort: project pages should attempt to self-heal
 * missing orchestrators rather than forcing users through a separate CLI step.
 */
export async function ensureProjectOrchestrator(
  projectId: string,
): Promise<DashboardOrchestratorLink | null> {
  const locks = getProjectLocks();
  const inFlight = locks.get(projectId);
  if (inFlight) return inFlight;

  const task = (async (): Promise<DashboardOrchestratorLink | null> => {
    const { config, sessionManager } = await getServices();
    const project = config.projects[projectId];
    if (!project || project.enabled === false) return null;

    const allSessions = await sessionManager.list();
    const existing = listDashboardOrchestrators(
      allSessions.filter((session) => isOrchestratorSession(session)),
      config.projects,
    ).find((orchestrator) => orchestrator.projectId === projectId);

    if (existing) return existing;

    const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });
    const session = await sessionManager.spawnOrchestrator({ projectId, systemPrompt });
    return {
      id: session.id,
      projectId,
      projectName: project.name ?? projectId,
    };
  })();

  locks.set(projectId, task);
  try {
    return await task;
  } finally {
    if (locks.get(projectId) === task) {
      locks.delete(projectId);
    }
  }
}

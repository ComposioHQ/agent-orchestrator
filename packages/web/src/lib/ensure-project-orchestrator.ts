import { generateOrchestratorPrompt, isOrchestratorSession } from "@composio/ao-core";
import type { DashboardOrchestratorLink } from "@/lib/types";
import { getServices } from "@/lib/services";
import { listDashboardOrchestrators } from "@/lib/serialize";

/**
 * Ensure the canonical per-project orchestrator exists.
 *
 * This is intentionally best-effort: project pages should attempt to self-heal
 * missing orchestrators rather than forcing users through a separate CLI step.
 */
export async function ensureProjectOrchestrator(
  projectId: string,
): Promise<DashboardOrchestratorLink | null> {
  const { config, sessionManager } = await getServices();
  const project = config.projects[projectId];
  if (!project) return null;

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
}

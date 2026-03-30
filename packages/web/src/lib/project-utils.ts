import { isOrchestratorSession } from "@composio/ao-core/types";

type ProjectWithPrefix = { sessionPrefix?: string };
type SessionLike = { id: string; projectId: string; metadata?: Record<string, string> };

/**
 * Check if a session belongs to a specific project.
 * Matches by projectId or sessionPrefix (same logic as resolveProject).
 *
 * @param session - Session with id and projectId
 * @param projectId - The project key to match against
 * @param projects - Projects config mapping
 */
function matchesProject(
  session: SessionLike,
  projectId: string,
  projects: Record<string, ProjectWithPrefix>,
): boolean {
  if (session.projectId === projectId) return true;
  const project = projects[projectId];
  if (project?.sessionPrefix && session.id.startsWith(project.sessionPrefix)) return true;
  // Removed loose reverse-match fallback (projects[session.projectId]?.sessionPrefix === projectId)
  // to prevent cross-project leakage in multi-project portfolios
  return false;
}

export function filterProjectSessions<T extends SessionLike>(
  sessions: T[],
  projectFilter: string | null | undefined,
  projects: Record<string, ProjectWithPrefix>,
): T[] {
  if (!projectFilter || projectFilter === "all") return sessions;
  return sessions.filter((session) => matchesProject(session, projectFilter, projects));
}

/** Build a project-scoped href, falling back to ?project=all when no project is active. */
export function getProjectScopedHref(
  basePath: "/" | "/prs",
  projectId: string | undefined,
): string {
  return projectId ? `${basePath}?project=${encodeURIComponent(projectId)}` : `${basePath}?project=all`;
}

export function getProjectSessionHref(projectId: string, sessionId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
}

export function filterWorkerSessions<T extends SessionLike>(
  sessions: T[],
  projectFilter: string | null | undefined,
  projects: Record<string, ProjectWithPrefix>,
): T[] {
  const workers = sessions.filter((s) => !isOrchestratorSession(s));
  return filterProjectSessions(workers, projectFilter, projects);
}

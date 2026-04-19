import type { ProjectConfig } from "./types.js";

export interface SpawnTarget {
  projectId: string;
  issueId: string;
}

/**
 * Parse a possibly-prefixed issue reference into a `{ projectId, issueId }` pair.
 *
 * When the reference is of the form `<prefix>/<rest>` and `<prefix>` matches a
 * configured project id or `sessionPrefix`, the spawn should be routed to that
 * project with `<rest>` as the issue id. Otherwise the reference is treated as
 * a plain issue id and the fallback project is used.
 *
 * - Exact project-id match wins over `sessionPrefix` match (yaml keys are
 *   unique; `sessionPrefix` values are not guaranteed to be).
 * - Returns `null` when no prefix routing matches and no fallback is provided.
 * - Empty `<rest>` (trailing slash) is rejected — nothing useful to spawn with.
 */
export function resolveSpawnTarget(
  projects: Record<string, ProjectConfig>,
  issueRef: string | undefined,
  fallbackProjectId?: string,
): SpawnTarget | null {
  if (!issueRef) {
    return fallbackProjectId ? { projectId: fallbackProjectId, issueId: "" } : null;
  }

  const slashIdx = issueRef.indexOf("/");
  if (slashIdx > 0 && slashIdx < issueRef.length - 1) {
    const prefix = issueRef.slice(0, slashIdx);
    const rest = issueRef.slice(slashIdx + 1);

    if (projects[prefix]) {
      return { projectId: prefix, issueId: rest };
    }
    for (const [pid, project] of Object.entries(projects)) {
      if (project.sessionPrefix === prefix) {
        return { projectId: pid, issueId: rest };
      }
    }
  }

  if (!fallbackProjectId) return null;
  return { projectId: fallbackProjectId, issueId: issueRef };
}

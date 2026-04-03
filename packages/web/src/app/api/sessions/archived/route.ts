import {
  listAllArchivedSessions,
  getSessionsDir,
  loadConfig,
} from "@composio/ao-core";
import type { ArchivedSession } from "@/lib/types";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function prNumberFromUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? parseInt(match[1], 10) : null;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectFilter = searchParams.get("project");
    const limit = parseLimit(searchParams.get("limit"));

    let config: ReturnType<typeof loadConfig>;
    try {
      config = loadConfig();
    } catch {
      return Response.json({ error: "No config found" }, { status: 500 });
    }

    const projectIds =
      projectFilter && projectFilter !== "all" && config.projects[projectFilter]
        ? [projectFilter]
        : Object.keys(config.projects);

    const allArchived: ArchivedSession[] = [];

    for (const projectId of projectIds) {
      const project = config.projects[projectId];
      if (!project) continue;

      const sessionsDir = getSessionsDir(config.configPath, project.path);
      const entries = listAllArchivedSessions(sessionsDir, limit);

      for (const entry of entries) {
        const prUrl = entry.metadata["pr"] || null;
        allArchived.push({
          sessionId: entry.sessionId,
          archivedAt: entry.archivedAt.toISOString(),
          status: entry.metadata["status"] ?? "unknown",
          branch: entry.metadata["branch"] ?? null,
          prUrl,
          prNumber: prNumberFromUrl(prUrl),
          summary: entry.metadata["summary"] ?? null,
          projectId: entry.metadata["project"] ?? projectId,
        });
      }
    }

    // Sort newest-first and apply global limit
    allArchived.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
    const result = allArchived.slice(0, limit);

    return Response.json({ archived: result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to list archived sessions" },
      { status: 500 },
    );
  }
}

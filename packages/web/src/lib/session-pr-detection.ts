import type {
  OrchestratorConfig,
  PluginRegistry,
  ProjectConfig,
  Session,
  SessionManager,
  Tracker,
} from "@composio/ao-core";

/** Extract short issue id (e.g. CLA-5) from issueId which may be a URL or plain id. */
function issueIdToShortId(issueId: string): string {
  if (!issueId.includes("/") && !issueId.includes(".")) return issueId;
  const segment = issueId.replace(/\/$/, "").split("/").pop();
  return segment ?? issueId;
}

/**
 * Ensure a session has branch/workspace context needed for PR detection.
 * If missing, derive branch from tracker + issue id where possible.
 */
function ensureSessionBranchContext(
  session: Session,
  project: ProjectConfig,
  registry: PluginRegistry,
): void {
  if (session.branch || session.workspacePath || !session.issueId || !project.tracker) return;
  const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
  if (!tracker?.branchName) return;
  try {
    const shortId = issueIdToShortId(session.issueId);
    const derivedBranch = tracker.branchName(shortId, project);
    if (derivedBranch) {
      (session as { branch: string | null }).branch = derivedBranch;
    }
  } catch {
    // best effort
  }
}

/**
 * Detect and persist missing PR metadata for sessions.
 * Keeps heavy SCM calls out of SessionManager.list() while still allowing
 * callers that render PR state to opt in.
 * Runs per-session detection in parallel with an aggregate timeout so SSR/API
 * don't block for 35s × N (avoids sequential gh pr list / git rev-parse).
 */
export async function ensureSessionsHaveDetectedPRs(args: {
  sessions: Session[];
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
}): Promise<void> {
  const { sessions, config, registry, sessionManager } = args;
  const toEnrich: { index: number; session: Session; project: ProjectConfig }[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (s.pr) continue;
    const project = config.projects[s.projectId];
    if (!project?.scm) continue;
    ensureSessionBranchContext(s, project, registry);
    if (!s.branch && !s.workspacePath) continue;
    toEnrich.push({ index: i, session: s, project });
  }
  if (toEnrich.length === 0) return;

  const timeoutMs = 10_000;
  const aggregateTimeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), timeoutMs),
  );
  const settled = Promise.allSettled(
    toEnrich.map(({ index, session, project }) =>
      sessionManager.ensurePRDetected(session, project).then((updated) => ({ index, updated })),
    ),
  );
  const results = await Promise.race([settled, aggregateTimeout]);
  if (results !== null) {
    for (const r of results) {
      if (r.status === "fulfilled" && r.value?.updated) {
        sessions[r.value.index] = r.value.updated;
      }
    }
  }
}

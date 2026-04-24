/**
 * Claim an existing PR for a worker session.
 *
 * Extracted from session-manager.ts. Given a PR reference (URL, #number, or
 * owner/repo#n), this validates the PR is open, checks out the branch in the
 * session's workspace, records the claim in metadata, and detaches any other
 * sessions that were previously tracking the same PR or branch.
 */

import {
  type ClaimPROptions,
  type ClaimPRResult,
  type SessionId,
  PR_STATE,
} from "./types.js";
import { readMetadataRaw, updateMetadata } from "./metadata.js";
import { deriveLegacyStatus } from "./lifecycle-state.js";
import { validateStatus } from "./utils/validation.js";
import {
  buildUpdatedLifecycle,
  lifecycleMetadataUpdates,
  PR_TRACKING_STATUSES,
  type SessionManagerContext,
} from "./session-manager-internals.js";

export async function claimPR(
  ctx: SessionManagerContext,
  sessionId: SessionId,
  prRef: string,
  options?: ClaimPROptions,
): Promise<ClaimPRResult> {
  const reference = prRef.trim();
  if (!reference) throw new Error("PR reference is required");

  const { raw, sessionsDir, project, projectId } = ctx.requireSessionRecord(sessionId);
  if (ctx.isOrchestratorSessionRecord(sessionId, raw, project.sessionPrefix)) {
    throw new Error(`Session ${sessionId} is an orchestrator session and cannot claim PRs`);
  }

  const plugins = ctx.resolvePlugins(
    project,
    ctx.resolveSelectionForSession(project, sessionId, raw).agentName,
  );
  const scm = plugins.scm;
  if (!scm?.resolvePR || !scm.checkoutPR) {
    throw new Error(
      `SCM plugin ${project.scm?.plugin ? `"${project.scm.plugin}" ` : ""}does not support claiming existing PRs`,
    );
  }

  const pr = await scm.resolvePR(reference, project);
  const prState = await scm.getPRState(pr);
  if (prState !== PR_STATE.OPEN) {
    throw new Error(`Cannot claim PR #${pr.number} because it is ${prState}`);
  }

  const conflictingSessions = new Set<SessionId>();
  const activeRecords = ctx
    .loadActiveSessionRecords(project)
    .filter((record) => record.sessionName !== sessionId);

  for (const { sessionName, raw: otherRaw } of activeRecords) {
    if (!otherRaw || ctx.isOrchestratorSessionRecord(sessionName, otherRaw, project.sessionPrefix))
      continue;

    const samePr = otherRaw["pr"] === pr.url;
    const sameBranch =
      otherRaw["branch"] === pr.branch && (otherRaw["prAutoDetect"] ?? "on") !== "off";

    if (samePr || sameBranch) {
      conflictingSessions.add(sessionName);
    }
  }

  const takenOverFrom = [...conflictingSessions];

  const workspacePath = raw["worktree"];
  if (!workspacePath) {
    throw new Error(`Session ${sessionId} has no workspace to check out PR #${pr.number}`);
  }

  const branchChanged = await scm.checkoutPR(pr, workspacePath);

  const claimLifecycle = buildUpdatedLifecycle(sessionId, raw, (next) => {
    next.pr.state = "open";
    next.pr.reason = "in_progress";
    next.pr.number = pr.number;
    next.pr.url = pr.url;
    next.pr.lastObservedAt = new Date().toISOString();
  });
  updateMetadata(sessionsDir, sessionId, {
    pr: pr.url,
    status: deriveLegacyStatus(claimLifecycle, validateStatus(raw["status"])),
    branch: pr.branch,
    prAutoDetect: "",
    ...lifecycleMetadataUpdates(raw, claimLifecycle),
  });
  ctx.invalidateCache();

  for (const previousSessionId of takenOverFrom) {
    const previousRaw = readMetadataRaw(sessionsDir, previousSessionId);
    if (!previousRaw) continue;

    const previousLifecycle = buildUpdatedLifecycle(previousSessionId, previousRaw, (next) => {
      next.pr.state = "none";
      next.pr.reason = "not_created";
      next.pr.number = null;
      next.pr.url = null;
      next.pr.lastObservedAt = null;
      if (PR_TRACKING_STATUSES.has(previousRaw["status"] ?? "")) {
        next.session.state = "working";
        next.session.reason = "task_in_progress";
      }
    });
    updateMetadata(sessionsDir, previousSessionId, {
      pr: "",
      prAutoDetect: "off",
      ...(PR_TRACKING_STATUSES.has(previousRaw["status"] ?? "") ? { status: "working" } : {}),
      ...lifecycleMetadataUpdates(previousRaw, previousLifecycle),
    });
    ctx.invalidateCache();
  }

  let githubAssigned = false;
  let githubAssignmentError: string | undefined;
  if (options?.assignOnGithub) {
    if (!scm.assignPRToCurrentUser) {
      githubAssignmentError = `SCM plugin "${scm.name}" does not support assigning PRs`;
    } else {
      try {
        await scm.assignPRToCurrentUser(pr);
        githubAssigned = true;
      } catch (err) {
        githubAssignmentError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  return {
    sessionId,
    projectId,
    pr,
    branchChanged,
    githubAssigned,
    githubAssignmentError,
    takenOverFrom,
  };
}

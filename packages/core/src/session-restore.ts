/**
 * Session restore and OpenCode session remap.
 *
 * Extracted from session-manager.ts. `restore` revives a terminated session in
 * place (same ID, workspace, metadata) by recreating the runtime process and
 * invoking the agent's `getRestoreCommand` when available.  `remap` is the
 * OpenCode-specific helper that re-resolves `opencodeSessionId` against the
 * OpenCode CLI's title index.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  SessionNotFoundError,
  SessionNotRestorableError,
  WorkspaceMissingError,
  isRestorable,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type SessionId,
} from "./types.js";
import { readArchivedMetadataRaw, updateMetadata, writeMetadata } from "./metadata.js";
import { getProjectBaseDir } from "./paths.js";
import { writeWorkspaceOpenCodeAgentsMd } from "./opencode-agents-md.js";
import { asValidOpenCodeSessionId } from "./opencode-session-id.js";
import {
  OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS,
  discoverOpenCodeSessionIdByTitle,
} from "./opencode-session-ops.js";
import type { SessionManagerContext } from "./session-manager-internals.js";

export async function remap(
  ctx: SessionManagerContext,
  sessionId: SessionId,
  force = false,
): Promise<string> {
  const { raw, sessionsDir, project } = ctx.requireSessionRecord(sessionId);

  const selection = ctx.resolveSelectionForSession(project, sessionId, raw);
  const selectedAgent = selection.agentName;
  if (selectedAgent !== "opencode") {
    throw new Error(`Session ${sessionId} is not using the opencode agent`);
  }

  const mapped = asValidOpenCodeSessionId(raw["opencodeSessionId"]);
  const discovered = force
    ? await discoverOpenCodeSessionIdByTitle(sessionId, OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS)
    : (mapped ??
      (await discoverOpenCodeSessionIdByTitle(
        sessionId,
        OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS,
      )));
  if (!discovered) {
    throw new Error(`OpenCode session mapping is missing for ${sessionId}`);
  }

  updateMetadata(sessionsDir, sessionId, { opencodeSessionId: discovered });
  return discovered;
}

export async function restore(
  ctx: SessionManagerContext,
  sessionId: SessionId,
): Promise<Session> {
  // 1. Find session metadata across all projects (active first, then archive)
  let raw: Record<string, string> | null = null;
  let sessionsDir: string | null = null;
  let project: ProjectConfig | undefined;
  let projectId: string | undefined;
  let fromArchive = false;

  const activeRecord = ctx.findSessionRecord(sessionId);
  if (activeRecord) {
    raw = activeRecord.raw;
    sessionsDir = activeRecord.sessionsDir;
    project = activeRecord.project;
    projectId = activeRecord.projectId;
  }

  // Fall back to archived metadata (killed/cleaned sessions)
  if (!raw) {
    for (const [key, proj] of Object.entries(ctx.config.projects)) {
      const dir = ctx.getProjectSessionsDir(proj);
      const archived = readArchivedMetadataRaw(dir, sessionId);
      if (archived) {
        raw = archived;
        sessionsDir = dir;
        project = proj;
        projectId = key;
        fromArchive = true;
        break;
      }
    }
  }

  if (!raw || !sessionsDir || !project || !projectId) {
    throw new SessionNotFoundError(sessionId);
  }

  const selection = ctx.resolveSelectionForSession(project, sessionId, raw);
  const selectedAgent = selection.agentName;
  if (selectedAgent === "opencode" && !asValidOpenCodeSessionId(raw["opencodeSessionId"])) {
    const discovered = await discoverOpenCodeSessionIdByTitle(
      sessionId,
      OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS,
    );
    if (!discovered) {
      throw new SessionNotRestorableError(sessionId, "OpenCode session mapping is missing");
    }
    raw = { ...raw, opencodeSessionId: discovered };
    if (!fromArchive) {
      updateMetadata(sessionsDir, sessionId, { opencodeSessionId: discovered });
    }
  }

  // 2. Reconstruct Session from metadata and enrich with live runtime state.
  //    metadataToSession sets activity: null, so without enrichment a crashed
  //    session (status "working", agent exited) would not be detected as terminal
  //    and isRestorable would reject it.
  const session = ctx.metadataToSession(sessionId, raw, projectId, project.sessionPrefix);
  const plugins = ctx.resolvePlugins(project, selection.agentName);
  await ctx.enrichSessionWithRuntimeState(session, plugins, true);

  // 3. Validate restorability
  if (!isRestorable(session)) {
    if (session.lifecycle.session.state === "done") {
      throw new SessionNotRestorableError(
        sessionId,
        `session state is "${session.lifecycle.session.state}"`,
      );
    }
    throw new SessionNotRestorableError(sessionId, "session is not in a terminal state");
  }

  if (fromArchive) {
    writeMetadata(sessionsDir, sessionId, {
      worktree: raw["worktree"] ?? "",
      branch: raw["branch"] ?? "",
      status: raw["status"] ?? "terminated",
      stateVersion: raw["stateVersion"],
      statePayload: raw["statePayload"],
      role: raw["role"],
      tmuxName: raw["tmuxName"],
      issue: raw["issue"],
      pr: raw["pr"],
      prAutoDetect:
        raw["prAutoDetect"] === "off" ? "off" : raw["prAutoDetect"] === "on" ? "on" : undefined,
      summary: raw["summary"],
      project: raw["project"],
      agent: raw["agent"],
      createdAt: raw["createdAt"],
      runtimeHandle: raw["runtimeHandle"],
      opencodeSessionId: raw["opencodeSessionId"],
      pinnedSummary: raw["pinnedSummary"],
      displayName: raw["displayName"],
    });
  }

  // 4. Validate required plugins (plugins already resolved above for enrichment)
  if (!plugins.runtime) {
    throw new Error(
      `Runtime plugin '${project.runtime ?? ctx.config.defaults.runtime}' not found`,
    );
  }
  if (!plugins.agent) {
    throw new Error(`Agent plugin '${selection.agentName}' not found`);
  }

  // 5. Check workspace
  const workspacePath = raw["worktree"] || project.path;
  const workspaceExists = plugins.workspace?.exists
    ? await plugins.workspace.exists(workspacePath)
    : existsSync(workspacePath);

  if (!workspaceExists) {
    if (!plugins.workspace?.restore) {
      throw new WorkspaceMissingError(workspacePath, "workspace plugin does not support restore");
    }
    if (!session.branch) {
      throw new WorkspaceMissingError(workspacePath, "branch metadata is missing");
    }
    try {
      const wsInfo = await plugins.workspace.restore(
        {
          projectId,
          project,
          sessionId,
          branch: session.branch,
        },
        workspacePath,
      );

      if (plugins.workspace.postCreate) {
        await plugins.workspace.postCreate(wsInfo, project);
      }
    } catch (err) {
      throw new WorkspaceMissingError(
        workspacePath,
        `restore failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (plugins.agent.name === "opencode" && selection.role === "orchestrator") {
    const baseDir = getProjectBaseDir(project.storageKey);
    const systemPromptFile = join(baseDir, `orchestrator-prompt-${sessionId}.md`);
    if (existsSync(systemPromptFile)) {
      try {
        writeWorkspaceOpenCodeAgentsMd(workspacePath, systemPromptFile);
      } catch (err) {
        throw new Error(
          `failed to restore OpenCode orchestrator AGENTS.md: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }
  }

  // 6. Destroy old runtime if still alive (e.g. tmux session survives agent crash)
  if (session.runtimeHandle) {
    try {
      await plugins.runtime.destroy(session.runtimeHandle);
    } catch {
      // Best effort — may already be gone
    }
  }

  // 7. Get launch command — try restore command first, fall back to fresh launch
  let launchCommand: string;
  const projectConfigForLaunch: ProjectConfig = {
    ...project,
    agentConfig: {
      ...selection.agentConfig,
      ...(selection.role === "orchestrator" ? { permissions: "permissionless" as const } : {}),
      ...(session.metadata?.opencodeSessionId
        ? { opencodeSessionId: session.metadata.opencodeSessionId }
        : {}),
    },
  };
  const agentLaunchConfig = {
    sessionId,
    projectConfig: projectConfigForLaunch,
    issueId: session.issueId ?? undefined,
    permissions: selection.role === "orchestrator" ? "permissionless" : selection.permissions,
    model: selection.model,
    subagent: selection.subagent,
  };

  if (plugins.agent.getRestoreCommand) {
    const restoreCmd = await plugins.agent.getRestoreCommand(session, projectConfigForLaunch);
    launchCommand = restoreCmd ?? plugins.agent.getLaunchCommand(agentLaunchConfig);
  } else {
    launchCommand = plugins.agent.getLaunchCommand(agentLaunchConfig);
  }

  const environment = plugins.agent.getEnvironment(agentLaunchConfig);

  // 8. Create runtime (reuse tmuxName from metadata)
  const tmuxName = raw["tmuxName"];
  const handle: RuntimeHandle = await plugins.runtime.create({
    sessionId: tmuxName ?? sessionId,
    workspacePath,
    launchCommand,
    environment: {
      ...environment,
      AO_SESSION: sessionId,
      AO_DATA_DIR: sessionsDir,
      AO_SESSION_NAME: sessionId,
      ...(tmuxName && { AO_TMUX_NAME: tmuxName }),
      AO_CALLER_TYPE: "agent",
      ...(projectId && { AO_PROJECT_ID: projectId }),
      AO_CONFIG_PATH: ctx.config.configPath,
      ...(ctx.config.port !== undefined &&
        ctx.config.port !== null && { AO_PORT: String(ctx.config.port) }),
    },
  });

  // 9. Update metadata — merge updates, preserving existing fields
  const now = new Date().toISOString();
  updateMetadata(sessionsDir, sessionId, {
    status: "spawning",
    runtimeHandle: JSON.stringify(handle),
    restoredAt: now,
  });
  ctx.invalidateCache();

  // 10. Run postLaunchSetup (non-fatal)
  const restoredSession: Session = {
    ...session,
    status: "spawning",
    activity: "active",
    workspacePath,
    runtimeHandle: handle,
    restoredAt: new Date(now),
  };

  if (plugins.agent.postLaunchSetup) {
    try {
      const metadataBeforePostLaunch = { ...(restoredSession.metadata ?? {}) };
      await plugins.agent.postLaunchSetup(restoredSession);

      const metadataAfterPostLaunch = restoredSession.metadata ?? {};
      const metadataUpdates = Object.fromEntries(
        Object.entries(metadataAfterPostLaunch).filter(
          ([key, value]) => metadataBeforePostLaunch[key] !== value,
        ),
      );

      if (Object.keys(metadataUpdates).length > 0) {
        updateMetadata(sessionsDir, sessionId, metadataUpdates);
        ctx.invalidateCache();
      }
    } catch {
      // Non-fatal — session is already running
    }
  }

  return restoredSession;
}

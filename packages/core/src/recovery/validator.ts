import { existsSync } from "node:fs";
import {
  TERMINAL_STATUSES as TERMINAL_STATUSES_SET,
  type OrchestratorConfig,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type Workspace,
  type RuntimeHandle,
  type SessionStatus,
  type ActivityState,
} from "../types.js";
import { safeJsonParse, validateStatus } from "../utils/validation.js";
import type { ScannedSession } from "./scanner.js";
import {
  DEFAULT_RECOVERY_CONFIG,
  type RecoveryAssessment,
  type RecoveryClassification,
  type RecoveryAction,
  type RecoveryConfig,
} from "./types.js";
import { resolveAgentSelection, resolveSessionRole } from "../agent-selection.js";

export async function validateSession(
  scanned: ScannedSession,
  config: OrchestratorConfig,
  registry: PluginRegistry,
  recoveryConfigInput?: Partial<RecoveryConfig>,
): Promise<RecoveryAssessment> {
  const { sessionId, projectId, project, rawMetadata } = scanned;

  const runtimeName = project.runtime ?? config.defaults.runtime;
  const agentName = resolveAgentSelection({
    role: resolveSessionRole(
      sessionId,
      rawMetadata,
      project.sessionPrefix,
      Object.values(config.projects).map((p) => p.sessionPrefix),
    ),
    project,
    defaults: config.defaults,
    persistedAgent: rawMetadata["agent"],
  }).agentName;
  const workspaceName = project.workspace ?? config.defaults.workspace;

  const runtime = registry.get<Runtime>("runtime", runtimeName);
  const agent = registry.get<Agent>("agent", agentName);
  const workspace = registry.get<Workspace>("workspace", workspaceName);

  const workspacePath = rawMetadata["worktree"] || null;
  const runtimeHandleStr = rawMetadata["runtimeHandle"];
  const runtimeHandle = runtimeHandleStr ? safeJsonParse<RuntimeHandle>(runtimeHandleStr) : null;
  const metadataStatus = validateStatus(rawMetadata["status"]);
  const recoveryConfig: RecoveryConfig = {
    ...DEFAULT_RECOVERY_CONFIG,
    ...(recoveryConfigInput ?? {}),
  };

  let runtimeAlive = false;
  if (runtime && runtimeHandle) {
    try {
      runtimeAlive = await runtime.isAlive(runtimeHandle);
    } catch {
      runtimeAlive = false;
    }
  }

  let workspaceExists = false;
  if (workspacePath) {
    try {
      workspaceExists = existsSync(workspacePath);
    } catch {
      workspaceExists = false;
    }
    if (!workspaceExists && workspace?.exists) {
      try {
        workspaceExists = await workspace.exists(workspacePath);
      } catch {
        workspaceExists = false;
      }
    }
  }

  let agentProcessRunning = false;
  const agentActivity: ActivityState | null = null;
  if (agent && runtimeHandle) {
    try {
      agentProcessRunning = await agent.isProcessRunning(runtimeHandle);
    } catch {
      agentProcessRunning = false;
    }
  }

  const metadataValid = Object.keys(rawMetadata).length > 0;
  const classification = classifySession(
    runtimeAlive,
    workspaceExists,
    agentProcessRunning,
    metadataStatus,
  );
  const action = determineAction(classification, metadataStatus, recoveryConfig);

  return {
    sessionId,
    projectId,
    classification,
    action,
    reason: getReason(classification, runtimeAlive, workspaceExists, agentProcessRunning),
    runtimeAlive,
    runtimeHandle,
    workspaceExists,
    workspacePath,
    agentProcessRunning,
    agentActivity,
    metadataValid,
    metadataStatus,
    rawMetadata,
  };
}

function classifySession(
  runtimeAlive: boolean,
  workspaceExists: boolean,
  agentProcessRunning: boolean,
  metadataStatus: SessionStatus,
): RecoveryClassification {
  if (runtimeAlive && workspaceExists && agentProcessRunning) {
    return "live";
  }

  if (!runtimeAlive && !workspaceExists) {
    if (TERMINAL_STATUSES_SET.has(metadataStatus)) {
      return "unrecoverable";
    }
    return "dead";
  }

  if (runtimeAlive && !workspaceExists) {
    return "partial";
  }

  if (!runtimeAlive && workspaceExists) {
    return "dead";
  }

  if (runtimeAlive && workspaceExists && !agentProcessRunning) {
    return "partial";
  }

  return "partial";
}

function determineAction(
  classification: RecoveryClassification,
  _metadataStatus: SessionStatus,
  recoveryConfig: RecoveryConfig,
): RecoveryAction {
  switch (classification) {
    case "live":
      return "recover";
    case "dead":
      return recoveryConfig.autoCleanup ? "cleanup" : "escalate";
    case "partial":
      return recoveryConfig.escalatePartial ? "escalate" : "cleanup";
    case "unrecoverable":
      return "skip";
    default:
      return "skip";
  }
}

function getReason(
  classification: RecoveryClassification,
  runtimeAlive: boolean,
  workspaceExists: boolean,
  agentProcessRunning: boolean,
): string {
  switch (classification) {
    case "live":
      return "Session is running normally";
    case "dead":
      return `Runtime ${runtimeAlive ? "alive" : "dead"}, workspace ${workspaceExists ? "exists" : "missing"}`;
    case "partial":
      return `Incomplete state: runtime=${runtimeAlive}, workspace=${workspaceExists}, agent=${agentProcessRunning}`;
    case "unrecoverable":
      return "Session is in terminal state";
    default:
      return "Unknown classification";
  }
}

export { classifySession, determineAction };

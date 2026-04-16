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
  let runtimeProbeSucceeded = false;
  if (runtime && runtimeHandle) {
    try {
      runtimeAlive = await runtime.isAlive(runtimeHandle);
      runtimeProbeSucceeded = true;
    } catch {
      runtimeAlive = false;
      runtimeProbeSucceeded = false;
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
  let processProbeSucceeded = false;
  const agentActivity: ActivityState | null = null;
  if (agent && runtimeHandle) {
    try {
      agentProcessRunning = await agent.isProcessRunning(runtimeHandle);
      processProbeSucceeded = true;
    } catch {
      agentProcessRunning = false;
      processProbeSucceeded = false;
    }
  }

  const metadataValid = Object.keys(rawMetadata).length > 0;
  const classification = classifySession(
    runtimeAlive,
    workspaceExists,
    agentProcessRunning,
    metadataStatus,
    runtimeProbeSucceeded,
    processProbeSucceeded,
  );
  const signalDisagreement =
    runtimeProbeSucceeded &&
    processProbeSucceeded &&
    ((runtimeAlive && !agentProcessRunning) || (!runtimeAlive && agentProcessRunning));
  const recoveryRule = determineRecoveryRule(classification, signalDisagreement, metadataStatus);
  const action = determineAction(classification, metadataStatus, recoveryConfig, recoveryRule);

  return {
    sessionId,
    projectId,
    classification,
    action,
    reason: getReason(
      classification,
      runtimeAlive,
      workspaceExists,
      agentProcessRunning,
      runtimeProbeSucceeded,
      processProbeSucceeded,
      signalDisagreement,
    ),
    runtimeProbeSucceeded,
    processProbeSucceeded,
    signalDisagreement,
    recoveryRule,
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
  runtimeProbeSucceeded: boolean,
  processProbeSucceeded: boolean,
): RecoveryClassification {
  if (TERMINAL_STATUSES_SET.has(metadataStatus)) {
    return "unrecoverable";
  }

  if (metadataStatus === "detecting" || !runtimeProbeSucceeded || !processProbeSucceeded) {
    return "partial";
  }

  if (runtimeAlive && workspaceExists && agentProcessRunning) {
    return "live";
  }

  if (!runtimeAlive && !workspaceExists) {
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

function determineRecoveryRule(
  classification: RecoveryClassification,
  signalDisagreement: boolean,
  metadataStatus: SessionStatus,
): "auto" | "human" | "skip" {
  if (classification === "unrecoverable") return "skip";
  if (metadataStatus === "detecting" || signalDisagreement || classification === "partial") {
    return "human";
  }
  if (classification === "live" || classification === "dead") {
    return "auto";
  }
  return "human";
}

function determineAction(
  classification: RecoveryClassification,
  _metadataStatus: SessionStatus,
  recoveryConfig: RecoveryConfig,
  recoveryRule: "auto" | "human" | "skip",
): RecoveryAction {
  if (recoveryRule === "skip") {
    return "skip";
  }
  if (recoveryRule === "human") {
    return "escalate";
  }
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
  runtimeProbeSucceeded: boolean,
  processProbeSucceeded: boolean,
  signalDisagreement: boolean,
): string {
  if (!runtimeProbeSucceeded || !processProbeSucceeded) {
    return `Probe uncertainty: runtimeProbe=${runtimeProbeSucceeded}, processProbe=${processProbeSucceeded}`;
  }
  if (signalDisagreement) {
    return `Signal disagreement: runtime=${runtimeAlive}, workspace=${workspaceExists}, agent=${agentProcessRunning}`;
  }
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

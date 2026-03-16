import type { OrchestratorConfig, PluginRegistry, Runtime, Workspace } from "../types.js";
import { updateMetadata, deleteMetadata } from "../metadata.js";
import { getSessionsDir } from "../paths.js";
import { validateStatus } from "../utils/validation.js";
import { sessionFromMetadata } from "../utils/session-from-metadata.js";
import type { RecoveryAssessment, RecoveryResult, RecoveryContext } from "./types.js";

export async function recoverSession(
  assessment: RecoveryAssessment,
  config: OrchestratorConfig,
  registry: PluginRegistry,
  context: RecoveryContext,
): Promise<RecoveryResult> {
  const { sessionId, projectId, rawMetadata } = assessment;
  const recoveryCount = rawMetadata["recoveryCount"]
    ? parseInt(rawMetadata["recoveryCount"], 10) + 1
    : 1;

  if (context.dryRun) {
    if (recoveryCount > context.recoveryConfig.maxRecoveryAttempts) {
      return {
        success: true,
        sessionId,
        action: "escalate",
        requiresManualIntervention: true,
        reason: `Exceeded max recovery attempts (${context.recoveryConfig.maxRecoveryAttempts})`,
      };
    }

    return {
      success: true,
      sessionId,
      action: "recover",
    };
  }

  try {
    const now = new Date().toISOString();
    const preservedStatus = validateStatus(rawMetadata["status"]);

    const project = config.projects[projectId];
    const sessionsDir = getSessionsDir(config.configPath, project.path);

    if (recoveryCount > context.recoveryConfig.maxRecoveryAttempts) {
      updateMetadata(sessionsDir, sessionId, {
        status: "stuck",
        escalatedAt: now,
        escalationReason: `Exceeded max recovery attempts (${context.recoveryConfig.maxRecoveryAttempts})`,
        recoveryCount: String(recoveryCount),
      });

      return {
        success: true,
        sessionId,
        action: "escalate",
        requiresManualIntervention: true,
        reason: `Exceeded max recovery attempts (${context.recoveryConfig.maxRecoveryAttempts})`,
      };
    }

    updateMetadata(sessionsDir, sessionId, {
      status: preservedStatus,
      restoredAt: now,
      recoveryCount: String(recoveryCount),
    });

    const updatedMetadata = {
      ...rawMetadata,
      status: preservedStatus,
      restoredAt: now,
      recoveryCount: String(recoveryCount),
    };

    const session = sessionFromMetadata(sessionId, updatedMetadata, {
      projectId: assessment.projectId,
      status: preservedStatus,
      runtimeHandle: assessment.runtimeHandle,
      lastActivityAt: new Date(),
      restoredAt: new Date(now),
    });

    return {
      success: true,
      sessionId,
      action: "recover",
      session,
    };
  } catch (error) {
    return {
      success: false,
      sessionId,
      action: "recover",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function cleanupSession(
  assessment: RecoveryAssessment,
  config: OrchestratorConfig,
  registry: PluginRegistry,
  context: RecoveryContext,
): Promise<RecoveryResult> {
  const { sessionId, projectId, rawMetadata, runtimeAlive, workspaceExists } = assessment;

  if (context.dryRun) {
    return {
      success: true,
      sessionId,
      action: "cleanup",
    };
  }

  try {
    const project = config.projects[projectId];
    const runtimeName = project.runtime ?? config.defaults.runtime;
    const workspaceName = project.workspace ?? config.defaults.workspace;
    const runtime = registry.get<Runtime>("runtime", runtimeName);
    const workspace = registry.get<Workspace>("workspace", workspaceName);

    if (runtimeAlive && assessment.runtimeHandle && runtime) {
      try {
        await runtime.destroy(assessment.runtimeHandle);
      } catch {
        // ignore cleanup errors
      }
    }

    const workspacePath = rawMetadata["worktree"];
    if (workspacePath && workspaceExists && workspace) {
      try {
        await workspace.destroy(workspacePath);
      } catch {
        // ignore cleanup errors
      }
    }

    const sessionsDir = getSessionsDir(config.configPath, project.path);

    updateMetadata(sessionsDir, sessionId, {
      status: "terminated",
      terminatedAt: new Date().toISOString(),
      terminationReason: "cleanup",
    });

    deleteMetadata(sessionsDir, sessionId, true);

    return {
      success: true,
      sessionId,
      action: "cleanup",
    };
  } catch (error) {
    return {
      success: false,
      sessionId,
      action: "cleanup",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function escalateSession(
  assessment: RecoveryAssessment,
  config: OrchestratorConfig,
  _registry: PluginRegistry,
  context: RecoveryContext,
): Promise<RecoveryResult> {
  const { sessionId, projectId, reason } = assessment;

  if (context.dryRun) {
    return {
      success: true,
      sessionId,
      action: "escalate",
      requiresManualIntervention: true,
      reason,
    };
  }

  try {
    const project = config.projects[projectId];
    const sessionsDir = getSessionsDir(config.configPath, project.path);

    updateMetadata(sessionsDir, sessionId, {
      status: "stuck",
      escalatedAt: new Date().toISOString(),
      escalationReason: reason,
    });

    return {
      success: true,
      sessionId,
      action: "escalate",
      requiresManualIntervention: true,
      reason,
    };
  } catch (error) {
    return {
      success: false,
      sessionId,
      action: "escalate",
      error: error instanceof Error ? error.message : String(error),
      requiresManualIntervention: true,
    };
  }
}

export async function executeAction(
  assessment: RecoveryAssessment,
  config: OrchestratorConfig,
  registry: PluginRegistry,
  context: RecoveryContext,
): Promise<RecoveryResult> {
  switch (assessment.action) {
    case "recover":
      return recoverSession(assessment, config, registry, context);
    case "cleanup":
      return cleanupSession(assessment, config, registry, context);
    case "escalate":
      return escalateSession(assessment, config, registry, context);
    case "skip":
    default:
      return {
        success: true,
        sessionId: assessment.sessionId,
        action: "skip",
      };
  }
}

import type { OrchestratorConfig, PluginRegistry, Session } from "../types.js";
import { scanAllSessions, getRecoveryLogPath } from "./scanner.js";
import { validateSession } from "./validator.js";
import { executeAction } from "./actions.js";
import {
  writeRecoveryLog,
  createLogEntry,
  createEmptyReport,
  formatRecoveryReport,
} from "./logger.js";
import {
  DEFAULT_RECOVERY_CONFIG,
  type RecoveryContext,
  type RecoveryReport,
  type RecoveryResult,
  type RecoveryAssessment,
  type RecoveryConfig,
} from "./types.js";

export interface RecoveryManagerOptions {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  recoveryConfig?: Partial<RecoveryConfig>;
  dryRun?: boolean;
  projectFilter?: string;
}

export interface RecoveryRunResult {
  report: RecoveryReport;
  assessments: RecoveryAssessment[];
  results: RecoveryResult[];
  recoveredSessions: Session[];
}

export async function runRecovery(options: RecoveryManagerOptions): Promise<RecoveryRunResult> {
  const { config, registry, dryRun = false, projectFilter } = options;
  const startTime = Date.now();

  const recoveryConfig: RecoveryConfig = {
    ...DEFAULT_RECOVERY_CONFIG,
    ...options.recoveryConfig,
    logPath: getRecoveryLogPath(config.configPath),
  };

  const context: RecoveryContext = {
    configPath: config.configPath,
    recoveryConfig,
    dryRun,
  };

  const report = createEmptyReport();
  const assessments: RecoveryAssessment[] = [];
  const results: RecoveryResult[] = [];
  const recoveredSessions: Session[] = [];

  const scannedSessions = scanAllSessions(config, projectFilter);
  report.totalScanned = scannedSessions.length;

  for (const scanned of scannedSessions) {
    const assessment = await validateSession(scanned, config, registry);
    assessments.push(assessment);

    if (dryRun) {
      report.skipped.push(assessment.sessionId);
      continue;
    }

    const result = await executeAction(assessment, config, registry, context);
    results.push(result);

    if (result.success) {
      switch (result.action) {
        case "recover":
          report.recovered.push(assessment.sessionId);
          if (result.session) {
            recoveredSessions.push(result.session);
          }
          break;
        case "cleanup":
          report.cleanedUp.push(assessment.sessionId);
          break;
        case "escalate":
          report.escalated.push(assessment.sessionId);
          break;
        case "skip":
          report.skipped.push(assessment.sessionId);
          break;
      }
    } else {
      report.errors.push({
        sessionId: assessment.sessionId,
        error: result.error || "Unknown error",
      });
    }

    const logAction = mapActionToLogAction(result.action, result.success);
    writeRecoveryLog(
      recoveryConfig.logPath,
      createLogEntry(assessment.sessionId, logAction, {
        previousStatus: assessment.metadataStatus,
        reason: assessment.reason,
        error: result.error,
      }),
    );
  }

  report.durationMs = Date.now() - startTime;

  if (!dryRun) {
    console.log(formatRecoveryReport(report));
  }

  return {
    report,
    assessments,
    results,
    recoveredSessions,
  };
}

function mapActionToLogAction(
  action: string,
  success: boolean,
): "recovered" | "cleaned_up" | "escalated" | "skipped" | "error" {
  if (!success) return "error";
  switch (action) {
    case "recover":
      return "recovered";
    case "cleanup":
      return "cleaned_up";
    case "escalate":
      return "escalated";
    default:
      return "skipped";
  }
}

export async function recoverSessionById(
  sessionId: string,
  options: RecoveryManagerOptions,
): Promise<RecoveryResult | null> {
  const { config, registry, dryRun = false } = options;

  const recoveryConfig: RecoveryConfig = {
    ...DEFAULT_RECOVERY_CONFIG,
    ...options.recoveryConfig,
    logPath: getRecoveryLogPath(config.configPath),
  };

  const context: RecoveryContext = {
    configPath: config.configPath,
    recoveryConfig,
    dryRun,
  };

  const allSessions = scanAllSessions(config);
  const scanned = allSessions.find((s) => s.sessionId === sessionId);

  if (!scanned) {
    return null;
  }

  const assessment = await validateSession(scanned, config, registry);
  return executeAction(assessment, config, registry, context);
}

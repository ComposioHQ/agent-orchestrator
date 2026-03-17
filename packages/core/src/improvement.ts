import type {
  CreateIssueInput,
  Issue,
  OrchestratorConfig,
  PluginRegistry,
  ProjectConfig,
  Session,
  SessionManager,
  Tracker,
} from "./types.js";

/**
 * Adapter layer for issue #400.
 *
 * Assumptions until #398/#399 contracts land in this branch:
 * - Feedback schema is consumed through `FeedbackReportAdapter.normalize(...)`.
 * - Managed fork mode policy is consumed through `ForkModePolicyAdapter.resolveIssueTarget(...)`.
 * - This module does not define upstream state/storage formats; it composes existing services.
 */

export type ImprovementSeverity = "error" | "warning" | "info";

export interface NormalizedFeedbackReport {
  id: string;
  projectId: string;
  kind: "bug_report" | "improvement_suggestion";
  title: string;
  body: string;
  evidence: string;
  sourceSessionId: string;
  confidence: number;
  severity: ImprovementSeverity;
  labels?: string[];
  dedupeKey?: string;
  linkage?: Partial<ImprovementLinkage>;
}

export interface ImprovementLinkage {
  reportId: string;
  issueId: string;
  issueUrl: string;
  issueRepo: string;
  issueMode: string;
  sessionId: string;
  prUrl?: string;
  lastAttemptAt: string;
  lastError?: string;
}

export interface FeedbackReportAdapter<TRawReport = unknown> {
  getReport(reportId: string): Promise<TRawReport | null>;
  normalize(report: TRawReport, reportId: string): NormalizedFeedbackReport;
  updateLinkage(reportId: string, patch: Partial<ImprovementLinkage>): Promise<void>;
}

export interface ForkModeTarget {
  repo: string;
  mode: string;
}

export interface ForkModePolicyAdapter {
  resolveIssueTarget(input: { projectId: string; project: ProjectConfig }): Promise<ForkModeTarget>;
}

export interface ImprovementSpawnGuardrails {
  minConfidence: number;
  minSeverity: ImprovementSeverity;
}

export interface ImprovementServiceDeps<TRawReport = unknown> {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
  reports: FeedbackReportAdapter<TRawReport>;
  forkMode?: ForkModePolicyAdapter;
  guardrails?: Partial<ImprovementSpawnGuardrails>;
}

export interface ImprovementSpawnResult {
  reportId: string;
  issue: Issue;
  session: Session;
  issueTarget: ForkModeTarget;
  idempotentReuse: boolean;
}

const SEVERITY_RANK: Record<ImprovementSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

function ensureGuardrails(
  report: NormalizedFeedbackReport,
  guardrails: ImprovementSpawnGuardrails,
): void {
  if (report.confidence < guardrails.minConfidence) {
    throw new Error(
      `Report ${report.id} confidence ${report.confidence} is below threshold ${guardrails.minConfidence}`,
    );
  }
  if (SEVERITY_RANK[report.severity] < SEVERITY_RANK[guardrails.minSeverity]) {
    throw new Error(
      `Report ${report.id} severity ${report.severity} is below threshold ${guardrails.minSeverity}`,
    );
  }
}

function resolveTracker(
  config: OrchestratorConfig,
  registry: PluginRegistry,
  projectId: string,
): { project: ProjectConfig; tracker: Tracker } {
  const project = config.projects[projectId];
  if (!project) throw new Error(`Unknown project for report: ${projectId}`);
  if (!project.tracker) {
    throw new Error(`Project ${projectId} has no tracker configured`);
  }
  const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
  if (!tracker) {
    throw new Error(`Tracker plugin '${project.tracker.plugin}' not found for project ${projectId}`);
  }
  if (!tracker.createIssue) {
    throw new Error(`Tracker plugin '${tracker.name}' does not support createIssue(...)`);
  }
  return { project, tracker };
}

function buildIssueInput(report: NormalizedFeedbackReport): CreateIssueInput {
  const sections = [
    "## Feedback Report",
    `- Report ID: ${report.id}`,
    `- Kind: ${report.kind}`,
    `- Source Session: ${report.sourceSessionId}`,
    `- Confidence: ${report.confidence}`,
    `- Severity: ${report.severity}`,
    report.dedupeKey ? `- Dedupe Key: ${report.dedupeKey}` : undefined,
    "",
    "## Summary",
    report.body,
    "",
    "## Evidence",
    report.evidence || "No evidence provided",
  ].filter((line): line is string => line !== undefined);

  return {
    title: report.title,
    description: sections.join("\n"),
    labels: [...new Set(["self-improvement", ...(report.labels ?? [])])],
  };
}

function buildSpawnPrompt(report: NormalizedFeedbackReport): string {
  return [
    `You are implementing feedback report ${report.id}.`,
    `Kind: ${report.kind}`,
    `Severity: ${report.severity}`,
    `Confidence: ${report.confidence}`,
    `Source session: ${report.sourceSessionId}`,
    "",
    "Focus on the reported problem and include tests for the reported behavior.",
  ].join("\n");
}

async function maybeReuseExistingSession(
  sessionManager: SessionManager,
  report: NormalizedFeedbackReport,
): Promise<Session | null> {
  const existingSessionId = report.linkage?.sessionId;
  if (!existingSessionId) return null;
  return sessionManager.get(existingSessionId);
}

function toIsoNow(): string {
  return new Date().toISOString();
}

export function createImprovementService<TRawReport = unknown>(
  deps: ImprovementServiceDeps<TRawReport>,
): { spawn(reportId: string): Promise<ImprovementSpawnResult> } {
  const guardrails: ImprovementSpawnGuardrails = {
    minConfidence: deps.guardrails?.minConfidence ?? 0,
    minSeverity: deps.guardrails?.minSeverity ?? "info",
  };

  const resolveForkMode = async (
    projectId: string,
    project: ProjectConfig,
  ): Promise<ForkModeTarget> => {
    if (deps.forkMode) {
      return deps.forkMode.resolveIssueTarget({ projectId, project });
    }
    return { repo: project.repo, mode: "upstream-first" };
  };

  return {
    async spawn(reportId: string): Promise<ImprovementSpawnResult> {
      const raw = await deps.reports.getReport(reportId);
      if (!raw) throw new Error(`Feedback report not found: ${reportId}`);
      const report = deps.reports.normalize(raw, reportId);

      const { project, tracker } = resolveTracker(deps.config, deps.registry, report.projectId);
      const issueTarget = await resolveForkMode(report.projectId, project);

      const existingSession = await maybeReuseExistingSession(deps.sessionManager, report);
      if (existingSession && report.linkage?.issueId && report.linkage?.issueUrl) {
        if (existingSession.pr?.url) {
          await deps.reports.updateLinkage(report.id, { prUrl: existingSession.pr.url });
        }
        return {
          reportId: report.id,
          issue: {
            id: report.linkage.issueId,
            url: report.linkage.issueUrl,
            title: report.title,
            description: report.body,
            state: "open",
            labels: report.labels ?? [],
          },
          session: existingSession,
          issueTarget,
          idempotentReuse: true,
        };
      }

      try {
        ensureGuardrails(report, guardrails);

        const issue =
          report.linkage?.issueId && report.linkage?.issueUrl
            ? {
                id: report.linkage.issueId,
                url: report.linkage.issueUrl,
                title: report.title,
                description: report.body,
                state: "open" as const,
                labels: report.labels ?? [],
              }
            : await tracker.createIssue!(buildIssueInput(report), {
                ...project,
                repo: issueTarget.repo,
              });

        await deps.reports.updateLinkage(report.id, {
          issueId: issue.id,
          issueUrl: issue.url,
          issueRepo: issueTarget.repo,
          issueMode: issueTarget.mode,
          lastAttemptAt: toIsoNow(),
          lastError: "",
        });

        const session = await deps.sessionManager.spawn({
          projectId: report.projectId,
          issueId: issue.id,
          prompt: buildSpawnPrompt(report),
          metadata: {
            improvementReportId: report.id,
            improvementIssueId: issue.id,
            improvementIssueUrl: issue.url,
            improvementIssueRepo: issueTarget.repo,
            improvementIssueMode: issueTarget.mode,
            improvementSourceSessionId: report.sourceSessionId,
            improvementConfidence: String(report.confidence),
            improvementSeverity: report.severity,
          },
        });

        await deps.reports.updateLinkage(report.id, {
          issueId: issue.id,
          issueUrl: issue.url,
          issueRepo: issueTarget.repo,
          issueMode: issueTarget.mode,
          sessionId: session.id,
          prUrl: session.pr?.url,
          lastAttemptAt: toIsoNow(),
          lastError: "",
        });

        return {
          reportId: report.id,
          issue,
          session,
          issueTarget,
          idempotentReuse: false,
        };
      } catch (err) {
        await deps.reports.updateLinkage(report.id, {
          lastAttemptAt: toIsoNow(),
          lastError: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}

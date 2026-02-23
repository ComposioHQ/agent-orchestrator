/**
 * Phase Manager — workflow phase transitions for full-mode sessions.
 *
 * Transition + orchestration set:
 * - planning -> plan_review    when .ao/plan.md exists
 * - plan_review -> spawn reviewer sub-sessions when no review artifacts exist
 * - plan_review -> implementing when all reviewer decisions are approved
 * - plan_review -> planning     when any reviewer requested changes
 */

import {
  SESSION_PHASE,
  type OrchestratorConfig,
  type PhaseManager,
  type ReviewerRole,
  type Session,
  type SessionManager,
  type SessionPhase,
} from "./types.js";
import { updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";
import { isAllApproved, readPlanArtifact, readReviewArtifacts } from "./review-artifacts.js";

export interface PhaseManagerDeps {
  config: OrchestratorConfig;
  sessionManager?: SessionManager;
}

function parseRound(raw: string | undefined): number {
  const round = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(round) && round > 0 ? round : 1;
}

const DEFAULT_REVIEW_ROLES: ReviewerRole[] = ["architect", "developer", "product"];

export function createPhaseManager(deps: PhaseManagerDeps): PhaseManager {
  const { config, sessionManager } = deps;

  async function transitionPhase(
    session: Session,
    targetPhase: SessionPhase,
    extraUpdates?: Record<string, string>,
  ): Promise<SessionPhase> {
    if (targetPhase === session.phase) return session.phase;

    const project = config.projects[session.projectId];
    if (!project) return session.phase;

    const sessionsDir = getSessionsDir(config.configPath, project.path);
    updateMetadata(sessionsDir, session.id, {
      phase: targetPhase,
      ...extraUpdates,
    });

    session.phase = targetPhase;
    session.metadata["phase"] = targetPhase;
    for (const [key, value] of Object.entries(extraUpdates ?? {})) {
      session.metadata[key] = value;
    }
    return targetPhase;
  }

  function getPlanReviewRoles(session: Session): ReviewerRole[] {
    const project = config.projects[session.projectId];
    if (!project) return [];

    const configured = project.workflow?.planReview?.roles ?? DEFAULT_REVIEW_ROLES;
    return configured.length > 0 ? configured : DEFAULT_REVIEW_ROLES;
  }

  function buildPlanReviewPrompt(
    session: Session,
    role: ReviewerRole,
    round: number,
    planContent: string,
  ): string {
    const project = config.projects[session.projectId];
    const rolePrompt = project?.workflow?.planReview?.rolePrompts?.[role];
    const targetFile = `.ao/reviews/plan_review-round-${round}-${role}.md`;

    const sections = [
      `You are the ${role} reviewer for session ${session.id}.`,
      rolePrompt ? `Role-specific guidance: ${rolePrompt}` : "",
      "Review the current implementation plan from .ao/plan.md and produce a verdict.",
      `Write your review artifact to ${targetFile} using this exact header format:`,
      [
        `decision=approved|changes_requested|pending`,
        `round=${round}`,
        `phase=plan_review`,
        `role=${role}`,
        `timestamp=<ISO-8601 UTC>`,
        `---`,
      ].join("\n"),
      "After the header, include concise rationale and concrete requested changes if any.",
      planContent.trim().length > 0
        ? ["Plan snapshot:", "```markdown", planContent.trim(), "```"].join("\n")
        : "",
    ].filter((part) => part.length > 0);

    return sections.join("\n\n");
  }

  async function ensurePlanReviewSwarm(session: Session, round: number): Promise<void> {
    if (!sessionManager || !session.workspacePath) return;

    const roles = getPlanReviewRoles(session);
    if (roles.length === 0) return;

    const existing = await sessionManager.list(session.projectId);
    const existingRoles = new Set<ReviewerRole>();
    for (const candidate of existing) {
      const info = candidate.subSessionInfo;
      if (!info) continue;
      if (info.parentSessionId !== session.id) continue;
      if (info.phase !== SESSION_PHASE.PLAN_REVIEW) continue;
      if (info.round !== round) continue;
      existingRoles.add(info.role);
    }

    const planContent = readPlanArtifact(session.workspacePath) ?? "";

    for (const role of roles) {
      if (existingRoles.has(role)) continue;
      await sessionManager.spawn({
        projectId: session.projectId,
        issueId: session.issueId ?? undefined,
        branch: `review/${session.id}-plan-r${round}-${role}`,
        phase: SESSION_PHASE.PLAN_REVIEW,
        subSessionInfo: {
          parentSessionId: session.id,
          role,
          phase: SESSION_PHASE.PLAN_REVIEW,
          round,
        },
        prompt: buildPlanReviewPrompt(session, role, round, planContent),
      });
    }
  }

  return {
    async check(session: Session): Promise<SessionPhase> {
      const project = config.projects[session.projectId];
      if (!project) return session.phase;

      // Multi-phase logic is opt-in.
      if ((project.workflow?.mode ?? "simple") !== "full") {
        return session.phase;
      }

      if (!session.workspacePath) return session.phase;

      if (session.phase === SESSION_PHASE.PLANNING) {
        const plan = readPlanArtifact(session.workspacePath);
        if (plan && plan.trim().length > 0) {
          return transitionPhase(session, SESSION_PHASE.PLAN_REVIEW, { reviewRound: "1" });
        }
        return session.phase;
      }

      if (session.phase === SESSION_PHASE.PLAN_REVIEW) {
        const round = parseRound(session.metadata["reviewRound"]);
        const reviews = readReviewArtifacts(session.workspacePath, "plan_review", round);
        if (reviews.length === 0) {
          await ensurePlanReviewSwarm(session, round);
          return session.phase;
        }

        if (isAllApproved(reviews)) {
          return transitionPhase(session, SESSION_PHASE.IMPLEMENTING);
        }

        const hasChangesRequested = reviews.some((r) => r.decision === "changes_requested");
        if (hasChangesRequested) {
          return transitionPhase(session, SESSION_PHASE.PLANNING, { reviewRound: String(round + 1) });
        }
      }

      return session.phase;
    },
  };
}

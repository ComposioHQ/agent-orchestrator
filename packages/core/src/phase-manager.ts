/**
 * Phase Manager — workflow phase transitions for full-mode sessions.
 *
 * Initial transition set (Phase 2 MVP):
 * - planning -> plan_review    when .ao/plan.md exists
 * - plan_review -> implementing when all reviewer decisions are approved
 * - plan_review -> planning     when any reviewer requested changes
 */

import {
  SESSION_PHASE,
  type OrchestratorConfig,
  type PhaseManager,
  type Session,
  type SessionPhase,
} from "./types.js";
import { updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";
import { isAllApproved, readPlanArtifact, readReviewArtifacts } from "./review-artifacts.js";

export interface PhaseManagerDeps {
  config: OrchestratorConfig;
}

function parseRound(raw: string | undefined): number {
  const round = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(round) && round > 0 ? round : 1;
}

export function createPhaseManager(deps: PhaseManagerDeps): PhaseManager {
  const { config } = deps;

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
        if (reviews.length === 0) return session.phase;

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

/**
 * Phase Manager — workflow phase transitions for full-mode sessions.
 *
 * Transition + orchestration set:
 * - planning      -> planning swarm (optional) while plan is missing/stale
 * - planning      -> plan_review when .ao/plan.md is available for current round
 * - plan_review   -> spawn reviewer sub-sessions when no artifacts exist
 * - plan_review   -> implementing when all reviewers approved
 * - plan_review   -> planning when reviewers request changes
 * - implementing  -> implementation swarm (optional) for plan-driven parallel work
 * - implementing  -> code_review when PR reaches review states
 * - code_review   -> spawn reviewer sub-sessions when no artifacts exist
 * - code_review   -> ready_to_merge when all reviewers approved
 * - code_review   -> implementing when reviewers request changes
 */

import {
  SESSION_PHASE,
  isTerminalSession,
  type OrchestratorConfig,
  type PhaseManager,
  type ReviewerRole,
  type Session,
  type SessionManager,
  type SessionPhase,
  type SwarmExecutionConfig,
  type SwarmReviewConfig,
} from "./types.js";
import { updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";
import { readPlanArtifact, readReviewArtifacts } from "./review-artifacts.js";

export interface PhaseManagerDeps {
  config: OrchestratorConfig;
  sessionManager?: SessionManager;
}

const DEFAULT_REVIEW_ROLES: ReviewerRole[] = ["architect", "developer", "product"];
const DEFAULT_MAX_REVIEW_ROUNDS = 3;

function parseRound(raw: string | undefined): number {
  const round = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(round) && round > 0 ? round : 1;
}

function normalizeRoles(roles: ReviewerRole[] | undefined): ReviewerRole[] {
  const source = roles && roles.length > 0 ? roles : DEFAULT_REVIEW_ROLES;
  const unique: ReviewerRole[] = [];
  for (const role of source) {
    if (!unique.includes(role)) unique.push(role);
  }
  return unique.length > 0 ? unique : DEFAULT_REVIEW_ROLES;
}

function applyMaxAgents(roles: ReviewerRole[], maxAgents: number | undefined): ReviewerRole[] {
  if (!maxAgents || maxAgents <= 0) return roles;
  return roles.slice(0, Math.min(roles.length, maxAgents));
}

function splitPlanIntoWorkItems(planContent: string, targetCount: number): string[] {
  if (targetCount <= 0) return [];

  const lines = planContent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const checklistItems = lines
    .filter((line) => /^[-*]\s+(\[[ xX]\]\s*)?/.test(line) || /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""));

  const sectionHeadings = lines
    .filter((line) => /^##+\s+/.test(line))
    .map((line) => line.replace(/^##+\s+/, ""));

  const tasks = checklistItems.length > 0 ? checklistItems : sectionHeadings;

  if (tasks.length === 0) {
    return Array.from(
      { length: targetCount },
      () => "Implement your highest-impact part of .ao/plan.md and document delivered changes.",
    );
  }

  if (tasks.length <= targetCount) {
    return tasks;
  }

  const chunkSize = Math.ceil(tasks.length / targetCount);
  const chunks: string[] = [];
  for (let i = 0; i < targetCount; i++) {
    const chunk = tasks.slice(i * chunkSize, (i + 1) * chunkSize);
    if (chunk.length === 0) continue;
    chunks.push(chunk.join("\n- "));
  }

  while (chunks.length < targetCount) {
    chunks.push(tasks[tasks.length - 1] ?? "Continue implementation according to .ao/plan.md");
  }
  return chunks;
}

function hasPlanRoundMarker(planContent: string, round: number): boolean {
  if (round <= 1) return planContent.trim().length > 0;
  const marker = new RegExp(`\\bround\\s*[:=]\\s*${round}\\b`, "i");
  return marker.test(planContent);
}

function evaluateReviewRound(
  reviews: Array<{ role: ReviewerRole; decision: "approved" | "changes_requested" | "pending" }>,
  expectedRoles: ReviewerRole[],
): { allApproved: boolean; hasChangesRequested: boolean; completedRoles: Set<ReviewerRole> } {
  const byRole = new Map<ReviewerRole, "approved" | "changes_requested" | "pending">();
  for (const review of reviews) {
    byRole.set(review.role, review.decision);
  }

  const completedRoles = new Set<ReviewerRole>([...byRole.keys()]);
  const hasChangesRequested = [...byRole.values()].some((decision) => decision === "changes_requested");
  const allApproved =
    expectedRoles.length > 0 &&
    expectedRoles.every((role) => byRole.get(role) === "approved") &&
    byRole.size >= expectedRoles.length;

  return { allApproved, hasChangesRequested, completedRoles };
}

export function createPhaseManager(deps: PhaseManagerDeps): PhaseManager {
  const { config, sessionManager } = deps;

  async function transitionPhase(
    session: Session,
    targetPhase: SessionPhase,
    extraUpdates?: Record<string, string>,
  ): Promise<SessionPhase> {
    if (targetPhase === session.phase) {
      if (extraUpdates && Object.keys(extraUpdates).length > 0) {
        const project = config.projects[session.projectId];
        if (project) {
          const sessionsDir = getSessionsDir(config.configPath, project.path);
          updateMetadata(sessionsDir, session.id, extraUpdates);
          for (const [key, value] of Object.entries(extraUpdates)) {
            session.metadata[key] = value;
          }
        }
      }
      return session.phase;
    }

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

  async function getExistingSwarmRoles(
    session: Session,
    phase: SessionPhase,
    round: number,
    options?: { activeOnly?: boolean },
  ): Promise<Set<ReviewerRole>> {
    const existingRoles = new Set<ReviewerRole>();
    if (!sessionManager) return existingRoles;

    const existing = await sessionManager.list(session.projectId);
    for (const candidate of existing) {
      const info = candidate.subSessionInfo;
      if (!info) continue;
      if (info.parentSessionId !== session.id) continue;
      if (info.phase !== phase) continue;
      if (info.round !== round) continue;
      if (options?.activeOnly && isTerminalSession(candidate)) continue;
      existingRoles.add(info.role);
    }
    return existingRoles;
  }

  function getPlanningSwarmConfig(session: Session): SwarmExecutionConfig | undefined {
    const project = config.projects[session.projectId];
    return project?.workflow?.planningSwarm;
  }

  function getImplementationSwarmConfig(session: Session): SwarmExecutionConfig | undefined {
    const project = config.projects[session.projectId];
    return project?.workflow?.implementationSwarm;
  }

  function getReviewConfig(session: Session, phase: "plan_review" | "code_review"): SwarmReviewConfig | undefined {
    const project = config.projects[session.projectId];
    if (!project) return undefined;
    return phase === "plan_review" ? project.workflow?.planReview : project.workflow?.codeReview;
  }

  function getReviewMaxRounds(session: Session, phase: "plan_review" | "code_review"): number {
    return getReviewConfig(session, phase)?.maxRounds ?? DEFAULT_MAX_REVIEW_ROUNDS;
  }

  function buildPlanningPrompt(
    session: Session,
    role: ReviewerRole,
    round: number,
    existingPlan: string,
  ): string {
    const rolePrompt = getPlanningSwarmConfig(session)?.rolePrompts?.[role];
    const notesTarget = `.ao/planning/planning-round-${round}-${role}.md`;

    const sections = [
      `You are the ${role} planner for session ${session.id}.`,
      rolePrompt ? `Role-specific guidance: ${rolePrompt}` : "",
      `Round=${round}. Work in planning mode only (no implementation).`,
      `Write your analysis notes to ${notesTarget}.`,
      "Then help refine .ao/plan.md.",
      round > 1
        ? `Important: update .ao/plan.md with marker \`round=${round}\` so orchestrator knows this revision is fresh.`
        : "",
      existingPlan.trim().length > 0
        ? ["Current plan snapshot:", "```markdown", existingPlan.trim(), "```"].join("\n")
        : "Current plan is empty or missing. Build an initial plan with clear tasks and acceptance criteria.",
    ].filter((part) => part.length > 0);

    return sections.join("\n\n");
  }

  async function ensurePlanningSwarm(session: Session, round: number, planContent: string): Promise<void> {
    if (!sessionManager) return;

    const swarm = getPlanningSwarmConfig(session);
    if (!swarm) return;
    const roles = applyMaxAgents(normalizeRoles(swarm?.roles), swarm?.maxAgents);
    if (roles.length === 0) return;

    const existingRoles = await getExistingSwarmRoles(session, SESSION_PHASE.PLANNING, round, {
      activeOnly: true,
    });

    for (const role of roles) {
      if (existingRoles.has(role)) continue;
      await sessionManager.spawn({
        projectId: session.projectId,
        issueId: session.issueId ?? undefined,
        branch: `plan/${session.id}-r${round}-${role}`,
        phase: SESSION_PHASE.PLANNING,
        subSessionInfo: {
          parentSessionId: session.id,
          role,
          phase: SESSION_PHASE.PLANNING,
          round,
        },
        prompt: buildPlanningPrompt(session, role, round, planContent),
      });
    }
  }

  function buildReviewPrompt(
    session: Session,
    phase: "plan_review" | "code_review",
    role: ReviewerRole,
    round: number,
    planContent: string,
  ): string {
    const reviewConfig = getReviewConfig(session, phase);
    const rolePrompt = reviewConfig?.rolePrompts?.[role];
    const targetFile = `.ao/reviews/${phase}-round-${round}-${role}.md`;

    const sections = [
      `You are the ${role} reviewer for session ${session.id}.`,
      rolePrompt ? `Role-specific guidance: ${rolePrompt}` : "",
      phase === "plan_review"
        ? "Review the implementation plan and provide verdict."
        : "Review the implemented changes and provide verdict.",
      session.pr ? `PR: ${session.pr.url}` : "",
      `Write your review artifact to ${targetFile} using this exact header format:`,
      [
        `decision=approved|changes_requested|pending`,
        `round=${round}`,
        `phase=${phase}`,
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

  async function ensureReviewSwarm(
    session: Session,
    phase: "plan_review" | "code_review",
    round: number,
    planContent: string,
    completedRoles: Set<ReviewerRole>,
  ): Promise<void> {
    if (!sessionManager) return;

    const reviewConfig = getReviewConfig(session, phase);
    const roles = normalizeRoles(reviewConfig?.roles);
    if (roles.length === 0) return;

    const phaseValue = phase === "plan_review" ? SESSION_PHASE.PLAN_REVIEW : SESSION_PHASE.CODE_REVIEW;
    const existingRoles = await getExistingSwarmRoles(session, phaseValue, round, { activeOnly: true });

    for (const role of roles) {
      if (completedRoles.has(role)) continue;
      if (existingRoles.has(role)) continue;
      await sessionManager.spawn({
        projectId: session.projectId,
        issueId: session.issueId ?? undefined,
        branch: `review/${session.id}-${phase}-r${round}-${role}`,
        phase: phaseValue,
        subSessionInfo: {
          parentSessionId: session.id,
          role,
          phase: phaseValue,
          round,
        },
        prompt: buildReviewPrompt(session, phase, role, round, planContent),
      });
    }
  }

  function buildImplementationPrompt(
    session: Session,
    role: ReviewerRole,
    round: number,
    workItem: string,
    planContent: string,
  ): string {
    const rolePrompt = getImplementationSwarmConfig(session)?.rolePrompts?.[role];
    const notesTarget = `.ao/implementation/implementing-round-${round}-${role}.md`;

    const sections = [
      `You are the ${role} implementer for session ${session.id}.`,
      rolePrompt ? `Role-specific guidance: ${rolePrompt}` : "",
      `Round=${round}. Implement your assigned scope and keep changes cohesive.`,
      "Do not over-fragment tasks; prioritize high-leverage chunks.",
      `Assigned work item:\n- ${workItem}`,
      `Write execution notes and completion summary to ${notesTarget}.`,
      planContent.trim().length > 0
        ? ["Plan snapshot:", "```markdown", planContent.trim(), "```"].join("\n")
        : "",
    ].filter((part) => part.length > 0);

    return sections.join("\n\n");
  }

  async function ensureImplementationSwarm(session: Session, round: number): Promise<void> {
    if (!sessionManager || !session.workspacePath) return;

    const swarm = getImplementationSwarmConfig(session);
    if (!swarm) return;
    const configuredRoles = normalizeRoles(swarm?.roles);
    const roles = applyMaxAgents(configuredRoles, swarm?.maxAgents);
    if (roles.length === 0) return;

    const existingRoles = await getExistingSwarmRoles(session, SESSION_PHASE.IMPLEMENTING, round, {
      activeOnly: true,
    });
    const planContent = readPlanArtifact(session.workspacePath) ?? "";
    const workItems = splitPlanIntoWorkItems(planContent, roles.length);

    for (let i = 0; i < roles.length; i++) {
      const role = roles[i];
      if (!role || existingRoles.has(role)) continue;
      const workItem = workItems[i] ?? workItems[workItems.length - 1] ?? "Implement according to .ao/plan.md";

      await sessionManager.spawn({
        projectId: session.projectId,
        issueId: session.issueId ?? undefined,
        branch: `impl/${session.id}-r${round}-${role}`,
        phase: SESSION_PHASE.IMPLEMENTING,
        subSessionInfo: {
          parentSessionId: session.id,
          role,
          phase: SESSION_PHASE.IMPLEMENTING,
          round,
        },
        prompt: buildImplementationPrompt(session, role, round, workItem, planContent),
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
        const planRound = parseRound(session.metadata["planRound"] ?? session.metadata["reviewRound"]);
        const plan = readPlanArtifact(session.workspacePath) ?? "";
        const planReady = hasPlanRoundMarker(plan, planRound);
        if (planReady) {
          return transitionPhase(session, SESSION_PHASE.PLAN_REVIEW, {
            reviewRound: String(planRound),
            planRound: String(planRound),
          });
        }

        await ensurePlanningSwarm(session, planRound, plan);
        return session.phase;
      }

      if (session.phase === SESSION_PHASE.PLAN_REVIEW) {
        const round = parseRound(session.metadata["reviewRound"]);
        const maxRounds = getReviewMaxRounds(session, "plan_review");
        const reviews = readReviewArtifacts(session.workspacePath, "plan_review", round);
        const expectedRoles = normalizeRoles(getReviewConfig(session, "plan_review")?.roles);
        const reviewState = evaluateReviewRound(reviews, expectedRoles);

        if (reviewState.allApproved) {
          return transitionPhase(session, SESSION_PHASE.IMPLEMENTING, {
            implementationRound: session.metadata["implementationRound"] ?? "1",
          });
        }

        if (reviewState.hasChangesRequested) {
          if (round >= maxRounds) {
            return session.phase;
          }
          const nextRound = String(round + 1);
          return transitionPhase(session, SESSION_PHASE.PLANNING, {
            reviewRound: nextRound,
            planRound: nextRound,
          });
        }

        const planContent = readPlanArtifact(session.workspacePath) ?? "";
        await ensureReviewSwarm(
          session,
          "plan_review",
          round,
          planContent,
          reviewState.completedRoles,
        );

        return session.phase;
      }

      if (session.phase === SESSION_PHASE.IMPLEMENTING) {
        const round = parseRound(session.metadata["implementationRound"]);

        if (session.pr && ["review_pending", "approved", "mergeable"].includes(session.status)) {
          return transitionPhase(session, SESSION_PHASE.CODE_REVIEW, {
            codeReviewRound: session.metadata["codeReviewRound"] ?? "1",
          });
        }

        await ensureImplementationSwarm(session, round);
        return session.phase;
      }

      if (session.phase === SESSION_PHASE.CODE_REVIEW) {
        const round = parseRound(session.metadata["codeReviewRound"]);
        const maxRounds = getReviewMaxRounds(session, "code_review");
        const reviews = readReviewArtifacts(session.workspacePath, "code_review", round);
        const expectedRoles = normalizeRoles(getReviewConfig(session, "code_review")?.roles);
        const reviewState = evaluateReviewRound(reviews, expectedRoles);

        if (reviewState.allApproved) {
          return transitionPhase(session, SESSION_PHASE.READY_TO_MERGE);
        }

        if (reviewState.hasChangesRequested) {
          if (round >= maxRounds) {
            return session.phase;
          }
          const nextReviewRound = String(round + 1);
          const implementationRound = String(parseRound(session.metadata["implementationRound"]) + 1);
          return transitionPhase(session, SESSION_PHASE.IMPLEMENTING, {
            codeReviewRound: nextReviewRound,
            implementationRound,
          });
        }

        const planContent = readPlanArtifact(session.workspacePath) ?? "";
        await ensureReviewSwarm(
          session,
          "code_review",
          round,
          planContent,
          reviewState.completedRoles,
        );
      }

      return session.phase;
    },
  };
}

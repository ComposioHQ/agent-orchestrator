/**
 * Agent routing helpers for phase-aware and role-aware session execution.
 *
 * Supports mixed-model workflows, e.g.:
 * - codingAgent = "codex"
 * - planReview.agent = "claude-code"
 * - planReview.roleAgents.product = "claude-code"
 */

import {
  SESSION_PHASE,
  type OrchestratorConfig,
  type ProjectConfig,
  type Session,
  type SessionPhase,
  type SwarmExecutionConfig,
  type SwarmReviewConfig,
} from "./types.js";

export interface AgentRoutingContext {
  phase: SessionPhase;
  subSessionInfo?: Session["subSessionInfo"];
}

function isReviewPhase(phase: SessionPhase): phase is "plan_review" | "code_review" {
  return phase === SESSION_PHASE.PLAN_REVIEW || phase === SESSION_PHASE.CODE_REVIEW;
}

function getReviewConfig(project: ProjectConfig, phase: SessionPhase): SwarmReviewConfig | undefined {
  if (phase === SESSION_PHASE.PLAN_REVIEW) {
    return project.workflow?.planReview;
  }
  if (phase === SESSION_PHASE.CODE_REVIEW) {
    return project.workflow?.codeReview;
  }
  return undefined;
}

function getExecutionConfig(
  project: ProjectConfig,
  phase: SessionPhase,
): SwarmExecutionConfig | undefined {
  if (phase === SESSION_PHASE.PLANNING) {
    return project.workflow?.planningSwarm;
  }
  if (phase === SESSION_PHASE.IMPLEMENTING) {
    return project.workflow?.implementationSwarm;
  }
  return undefined;
}

/**
 * Resolve agent plugin name for a session in current phase context.
 *
 * If context is omitted, phase routing is skipped and base project/default
 * agent is returned (backward-compatible behavior for non-session flows).
 *
 * Precedence:
 * 1) review role override (workflow.<phase>.roleAgents.<role>)
 * 2) review phase agent (workflow.<phase>.agent)
 * 3) workflow coding agent (workflow.codingAgent)
 * 4) project/default agent (project.agent || defaults.agent)
 */
export function resolveAgentName(
  config: OrchestratorConfig,
  project: ProjectConfig,
  context?: AgentRoutingContext,
): string {
  const defaultAgent = project.agent ?? config.defaults.agent;

  if (!project.workflow) {
    return defaultAgent;
  }

  const codingAgent = project.workflow.codingAgent ?? defaultAgent;

  if (project.workflow.mode !== "full") {
    return codingAgent;
  }

  if (!context) {
    return defaultAgent;
  }

  if (!context.subSessionInfo || !isReviewPhase(context.phase)) {
    const executionConfig = getExecutionConfig(project, context.phase);
    if (executionConfig && context.subSessionInfo) {
      const role = context.subSessionInfo.role;
      return executionConfig.roleAgents?.[role] ?? executionConfig.agent ?? codingAgent;
    }
    return codingAgent;
  }

  const reviewConfig = getReviewConfig(project, context.phase);
  const role = context.subSessionInfo.role;
  const roleAgent = reviewConfig?.roleAgents?.[role];
  if (roleAgent) {
    return roleAgent;
  }

  return reviewConfig?.agent ?? codingAgent;
}

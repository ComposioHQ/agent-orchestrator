import {
  CI_STATUS,
  PR_STATE,
  SESSION_STATUS,
  type ActivitySignal,
  type CanonicalPRReason,
  type CanonicalPRState,
  type CanonicalSessionReason,
  type CanonicalSessionState,
  type CIStatus,
  type PREnrichmentData,
  type SessionStatus,
} from "./types.js";
import { supportsRecentLiveness } from "./activity-signal.js";

export const DETECTING_MAX_ATTEMPTS = 3;

type ProbeState = "alive" | "dead" | "unknown";
type PRReviewDecision = PREnrichmentData["reviewDecision"];
type LifecycleSessionState = CanonicalSessionState;
type LifecycleSessionReason = CanonicalSessionReason;
type LifecyclePRState = CanonicalPRState;
type LifecyclePRReason = CanonicalPRReason;

interface LifecycleDecision {
  status: SessionStatus;
  evidence: string;
  detectingAttempts: number;
  sessionState?: LifecycleSessionState;
  sessionReason?: LifecycleSessionReason;
  prState?: LifecyclePRState;
  prReason?: LifecyclePRReason;
}

interface OpenPRDecisionInput {
  reviewDecision: PRReviewDecision;
  ciFailing: boolean;
  mergeable: boolean;
  shouldEscalateIdleToStuck: boolean;
  idleWasBlocked: boolean;
  activityEvidence: string;
}

interface ProbeResult {
  state: ProbeState;
  failed: boolean;
}

interface ProbeDecisionInput {
  currentAttempts: number;
  runtimeProbe: ProbeResult;
  processProbe: ProbeResult;
  canProbeRuntimeIdentity: boolean;
  activitySignal: ActivitySignal;
  activityEvidence: string;
  idleWasBlocked: boolean;
}

function createLifecycleDecision(decision: LifecycleDecision): LifecycleDecision {
  return decision;
}

export function createDetectingDecision(
  input: Pick<ProbeDecisionInput, "currentAttempts" | "idleWasBlocked"> & {
    evidence: string;
    reason?: LifecycleSessionReason;
  },
): LifecycleDecision {
  const attempts = input.currentAttempts + 1;
  if (attempts > DETECTING_MAX_ATTEMPTS) {
    return createLifecycleDecision({
      status: SESSION_STATUS.STUCK,
      evidence: input.evidence,
      detectingAttempts: attempts,
      sessionState: "stuck",
      sessionReason: input.idleWasBlocked ? "error_in_process" : "probe_failure",
    });
  }

  return createLifecycleDecision({
    status: SESSION_STATUS.DETECTING,
    evidence: input.evidence,
    detectingAttempts: attempts,
    sessionState: "detecting",
    sessionReason: input.reason ?? "probe_failure",
  });
}

function resolveTerminalPRStateDecision(
  prState: PREnrichmentData["state"] | "open",
): LifecycleDecision | null {
  if (prState === PR_STATE.MERGED) {
    return createLifecycleDecision({
      status: SESSION_STATUS.MERGED,
      evidence: "pr_merged",
      detectingAttempts: 0,
      prState: "merged",
      prReason: "merged",
      sessionState: "idle",
      sessionReason: "merged_waiting_decision",
    });
  }

  if (prState === PR_STATE.CLOSED) {
    return createLifecycleDecision({
      status: SESSION_STATUS.IDLE,
      evidence: "pr_closed",
      detectingAttempts: 0,
      prState: "closed",
      prReason: "closed_unmerged",
      sessionState: "idle",
      sessionReason: "pr_closed_waiting_decision",
    });
  }

  return null;
}

function resolveOpenPRDecision(input: OpenPRDecisionInput): LifecycleDecision {
  if (input.ciFailing) {
    return createLifecycleDecision({
      status: SESSION_STATUS.CI_FAILED,
      evidence: "ci_failing",
      detectingAttempts: 0,
      prState: "open",
      prReason: "ci_failing",
      sessionState: "working",
      sessionReason: "fixing_ci",
    });
  }

  if (input.reviewDecision === "changes_requested") {
    return createLifecycleDecision({
      status: SESSION_STATUS.CHANGES_REQUESTED,
      evidence: "review_changes_requested",
      detectingAttempts: 0,
      prState: "open",
      prReason: "changes_requested",
      sessionState: "working",
      sessionReason: "resolving_review_comments",
    });
  }

  if (input.reviewDecision === "approved" || input.reviewDecision === "none") {
    if (input.mergeable) {
      return createLifecycleDecision({
        status: SESSION_STATUS.MERGEABLE,
        evidence: "merge_ready",
        detectingAttempts: 0,
        prState: "open",
        prReason: "merge_ready",
        sessionState: "idle",
        sessionReason: "awaiting_external_review",
      });
    }

    if (input.reviewDecision === "approved") {
      return createLifecycleDecision({
        status: SESSION_STATUS.APPROVED,
        evidence: "review_approved",
        detectingAttempts: 0,
        prState: "open",
        prReason: "approved",
        sessionState: "idle",
        sessionReason: "awaiting_external_review",
      });
    }
  }

  if (input.reviewDecision === "pending") {
    return createLifecycleDecision({
      status: SESSION_STATUS.REVIEW_PENDING,
      evidence: "review_pending",
      detectingAttempts: 0,
      prState: "open",
      prReason: "review_pending",
      sessionState: "idle",
      sessionReason: "awaiting_external_review",
    });
  }

  if (input.shouldEscalateIdleToStuck) {
    return createLifecycleDecision({
      status: SESSION_STATUS.STUCK,
      evidence: `idle_beyond_threshold ${input.activityEvidence}`,
      detectingAttempts: 0,
      prState: "open",
      prReason: "in_progress",
      sessionState: "stuck",
      sessionReason: input.idleWasBlocked ? "error_in_process" : "probe_failure",
    });
  }

  return createLifecycleDecision({
    status: SESSION_STATUS.PR_OPEN,
    evidence: "pr_open",
    detectingAttempts: 0,
    prState: "open",
    prReason: "in_progress",
    sessionState: "idle",
    sessionReason: "pr_created",
  });
}

export function parseAttemptCount(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function resolveProbeDecision(input: ProbeDecisionInput): LifecycleDecision | null {
  const recentActivitySupportsLiveness = supportsRecentLiveness(input.activitySignal);

  if (input.runtimeProbe.failed || input.processProbe.failed) {
    return createDetectingDecision({
      currentAttempts: input.currentAttempts,
      idleWasBlocked: input.idleWasBlocked,
      evidence: `probe_failed runtime=${input.runtimeProbe.state} process=${input.processProbe.state} ${input.activityEvidence}`,
    });
  }

  if (
    (input.runtimeProbe.state === "dead" && input.processProbe.state === "alive") ||
    (input.runtimeProbe.state === "alive" && input.processProbe.state === "dead") ||
    (input.runtimeProbe.state === "dead" && recentActivitySupportsLiveness)
  ) {
    return createDetectingDecision({
      currentAttempts: input.currentAttempts,
      idleWasBlocked: input.idleWasBlocked,
      evidence: `signal_disagreement runtime=${input.runtimeProbe.state} process=${input.processProbe.state} ${input.activityEvidence}`,
      reason: input.runtimeProbe.state === "dead" ? "runtime_lost" : "agent_process_exited",
    });
  }

  if (
    input.runtimeProbe.state === "dead" &&
    input.processProbe.state === "unknown" &&
    input.canProbeRuntimeIdentity
  ) {
    return createDetectingDecision({
      currentAttempts: input.currentAttempts,
      idleWasBlocked: input.idleWasBlocked,
      evidence: `runtime_dead process_unknown ${input.activityEvidence}`,
      reason: "runtime_lost",
    });
  }

  if (
    input.runtimeProbe.state === "dead" &&
    input.processProbe.state === "dead" &&
    !recentActivitySupportsLiveness
  ) {
    return createLifecycleDecision({
      status: SESSION_STATUS.KILLED,
      evidence: `runtime_dead process_dead ${input.activityEvidence}`,
      detectingAttempts: 0,
      sessionState: "terminated",
      sessionReason: "runtime_lost",
    });
  }

  return null;
}

export function resolvePREnrichmentDecision(
  cachedData: PREnrichmentData,
  options: Pick<
    OpenPRDecisionInput,
    "shouldEscalateIdleToStuck" | "idleWasBlocked" | "activityEvidence"
  >,
): LifecycleDecision {
  const terminalDecision = resolveTerminalPRStateDecision(cachedData.state);
  if (terminalDecision) {
    return terminalDecision;
  }

  return resolveOpenPRDecision({
    reviewDecision: cachedData.reviewDecision,
    ciFailing: cachedData.ciStatus === CI_STATUS.FAILING,
    mergeable: cachedData.mergeable,
    shouldEscalateIdleToStuck: options.shouldEscalateIdleToStuck,
    idleWasBlocked: options.idleWasBlocked,
    activityEvidence: options.activityEvidence,
  });
}

export function resolvePRLiveDecision(input: {
  prState: "open" | "merged" | "closed";
  ciStatus: CIStatus;
  reviewDecision: PRReviewDecision;
  mergeable: boolean;
  shouldEscalateIdleToStuck: boolean;
  idleWasBlocked: boolean;
  activityEvidence: string;
}): LifecycleDecision {
  const terminalDecision = resolveTerminalPRStateDecision(input.prState);
  if (terminalDecision) {
    return terminalDecision;
  }

  return resolveOpenPRDecision({
    reviewDecision: input.reviewDecision,
    ciFailing: input.ciStatus === CI_STATUS.FAILING,
    mergeable: input.mergeable,
    shouldEscalateIdleToStuck: input.shouldEscalateIdleToStuck,
    idleWasBlocked: input.idleWasBlocked,
    activityEvidence: input.activityEvidence,
  });
}

export type { LifecycleDecision };

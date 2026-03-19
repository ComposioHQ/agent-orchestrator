/**
 * Governance types for the on-chain governance panel.
 *
 * These types mirror the smart contract structures from the governance plugin (#466):
 * - GovernanceRegistry.sol — Proposal lifecycle
 * - VotingPolicy.sol — Vote tallies and thresholds
 * - ExecutionPolicy.sol — Execution scopes and consent gates
 * - AttestationLog.sol — Evidence hashes
 */

// ── Proposal types ──────────────────────────────────────────────────────

export type ProposalStatus =
  | "draft"
  | "active"
  | "approved"
  | "rejected"
  | "executed"
  | "cancelled";

export interface Proposal {
  id: string;
  forkId: string;
  title: string;
  description: string;
  author: string; // wallet address
  status: ProposalStatus;
  createdAt: string;
  updatedAt: string;
  /** Voting deadline (ISO timestamp) */
  votingEndsAt: string;
  votes: VoteTally;
  executionScopes: ExecutionScope[];
  attestations: Attestation[];
  /** On-chain transaction hash for the proposal creation */
  txHash: string;
}

export interface VoteTally {
  for: number;
  against: number;
  abstain: number;
  quorumReached: boolean;
  quorumRequired: number; // basis points (e.g., 5000 = 50%)
  threshold: ThresholdType;
}

export type ThresholdType = "majority" | "supermajority" | "unanimous";

export interface Vote {
  voter: string; // wallet address
  proposalId: string;
  choice: VoteChoice;
  timestamp: string;
  txHash: string;
  /** Delegate who voted on behalf of voter, if any */
  delegate?: string;
}

export type VoteChoice = "for" | "against" | "abstain";

// ── Execution types ─────────────────────────────────────────────────────

export interface ExecutionScope {
  id: string;
  proposalId: string;
  scope: string; // mutation scope identifier
  consumed: boolean;
  consumedAt?: string;
  consumedBy?: string; // wallet address of executor
}

// ── Attestation types ───────────────────────────────────────────────────

export type AttestationKind = "ci" | "review_verdict" | "convergence_pattern" | "custom";

export interface Attestation {
  id: string;
  forkId: string;
  proposalId?: string;
  kind: AttestationKind;
  evidenceHash: string;
  attester: string; // wallet address
  timestamp: string;
  txHash: string;
  verified?: boolean;
}

// ── Fork & Policy types ─────────────────────────────────────────────────

export interface Fork {
  id: string;
  name: string;
  /** On-chain registry address */
  registryAddress: string;
  policy: GovernancePolicy;
  maintainers: string[]; // wallet addresses
  maintainerCount: number;
  proposalCount: number;
  attestationCount: number;
  createdAt: string;
  lastActivityAt: string;
}

export interface GovernancePolicy {
  forkId: string;
  quorum: number; // basis points
  threshold: ThresholdType;
  consentGates: ConsentGate[];
  maintainers: string[];
  updatedAt: string;
  /** Previous policy for diff view */
  previous?: GovernancePolicy;
}

export interface ConsentGate {
  action: string; // e.g., "createFork", "createPR", "switchTarget"
  requiresApproval: boolean;
  minApprovals: number;
}

// ── Timeline event types ────────────────────────────────────────────────

export type GovernanceEventType =
  | "proposal_created"
  | "proposal_status_changed"
  | "vote_cast"
  | "policy_updated"
  | "attestation_added"
  | "fork_created"
  | "execution_consumed";

export interface GovernanceTimelineEvent {
  id: string;
  type: GovernanceEventType;
  forkId: string;
  timestamp: string;
  actor: string; // wallet address
  summary: string;
  /** Reference to the related entity */
  ref: {
    proposalId?: string;
    attestationId?: string;
    forkId?: string;
  };
  txHash?: string;
}

// ── SSE event types ─────────────────────────────────────────────────────

export interface GovernanceSSESnapshot {
  type: "governance_snapshot";
  correlationId?: string;
  emittedAt: string;
  proposals: Proposal[];
  forks: Fork[];
  timeline: GovernanceTimelineEvent[];
}

// ── Dashboard state ─────────────────────────────────────────────────────

export interface GovernanceState {
  proposals: Proposal[];
  forks: Fork[];
  timeline: GovernanceTimelineEvent[];
  selectedForkId: string | null;
  loading: boolean;
}

// ── Utility functions ───────────────────────────────────────────────────

const STATUS_ORDER: Record<ProposalStatus, number> = {
  active: 0,
  draft: 1,
  approved: 2,
  executed: 3,
  rejected: 4,
  cancelled: 5,
};

export function sortProposalsByStatus(proposals: Proposal[]): Proposal[] {
  return [...proposals].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt.localeCompare(a.updatedAt),
  );
}

export function getProposalStatusColor(status: ProposalStatus): string {
  switch (status) {
    case "draft":
      return "var(--color-text-muted)";
    case "active":
      return "var(--color-status-working)";
    case "approved":
      return "var(--color-status-ready)";
    case "rejected":
      return "var(--color-status-error)";
    case "executed":
      return "var(--color-accent-violet)";
    case "cancelled":
      return "var(--color-text-tertiary)";
  }
}

export function getEventTypeLabel(type: GovernanceEventType): string {
  switch (type) {
    case "proposal_created":
      return "Proposal Created";
    case "proposal_status_changed":
      return "Status Changed";
    case "vote_cast":
      return "Vote Cast";
    case "policy_updated":
      return "Policy Updated";
    case "attestation_added":
      return "Attestation Added";
    case "fork_created":
      return "Fork Created";
    case "execution_consumed":
      return "Execution Consumed";
  }
}

export function getEventTypeColor(type: GovernanceEventType): string {
  switch (type) {
    case "proposal_created":
      return "var(--color-accent-blue)";
    case "proposal_status_changed":
      return "var(--color-accent-orange)";
    case "vote_cast":
      return "var(--color-accent-violet)";
    case "policy_updated":
      return "var(--color-accent-yellow)";
    case "attestation_added":
      return "var(--color-accent-green)";
    case "fork_created":
      return "var(--color-accent-purple)";
    case "execution_consumed":
      return "var(--color-status-ready)";
  }
}

export function formatAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function getVotePercentage(tally: VoteTally): { for: number; against: number; abstain: number } {
  const total = tally.for + tally.against + tally.abstain;
  if (total === 0) return { for: 0, against: 0, abstain: 0 };
  return {
    for: Math.round((tally.for / total) * 100),
    against: Math.round((tally.against / total) * 100),
    abstain: Math.round((tally.abstain / total) * 100),
  };
}

export function isVotingOpen(proposal: Proposal): boolean {
  return proposal.status === "active" && new Date(proposal.votingEndsAt) > new Date();
}

/**
 * Mock governance data provider.
 *
 * Simulates on-chain governance state until the governance plugin (#466) is wired in.
 * All data is in-memory and resets on server restart.
 */

import type {
  Proposal,
  Fork,
  GovernanceTimelineEvent,
  GovernancePolicy,
  Vote,
  Attestation,
  GovernanceSSESnapshot,
} from "./governance-types";

// ── Mock wallet addresses ───────────────────────────────────────────────

const WALLETS = {
  alice: "0x1234567890abcdef1234567890abcdef12345678",
  bob: "0xabcdef1234567890abcdef1234567890abcdef12",
  carol: "0x9876543210fedcba9876543210fedcba98765432",
  dave: "0xfedcba9876543210fedcba9876543210fedcba98",
  eve: "0x1111222233334444555566667777888899990000",
};

// ── Mock policies ───────────────────────────────────────────────────────

const POLICY_MAIN: GovernancePolicy = {
  forkId: "fork-main",
  quorum: 5000, // 50%
  threshold: "majority",
  consentGates: [
    { action: "createFork", requiresApproval: true, minApprovals: 2 },
    { action: "createPR", requiresApproval: false, minApprovals: 0 },
    { action: "switchTarget", requiresApproval: true, minApprovals: 1 },
    { action: "deployContract", requiresApproval: true, minApprovals: 3 },
  ],
  maintainers: [WALLETS.alice, WALLETS.bob, WALLETS.carol],
  updatedAt: "2026-03-15T10:00:00Z",
  previous: {
    forkId: "fork-main",
    quorum: 3000, // was 30%
    threshold: "majority",
    consentGates: [
      { action: "createFork", requiresApproval: true, minApprovals: 1 },
      { action: "createPR", requiresApproval: false, minApprovals: 0 },
      { action: "switchTarget", requiresApproval: true, minApprovals: 1 },
    ],
    maintainers: [WALLETS.alice, WALLETS.bob],
    updatedAt: "2026-03-01T10:00:00Z",
  },
};

const POLICY_EXPERIMENTAL: GovernancePolicy = {
  forkId: "fork-experimental",
  quorum: 3000, // 30%
  threshold: "majority",
  consentGates: [
    { action: "createFork", requiresApproval: false, minApprovals: 0 },
    { action: "createPR", requiresApproval: false, minApprovals: 0 },
    { action: "switchTarget", requiresApproval: true, minApprovals: 1 },
  ],
  maintainers: [WALLETS.dave, WALLETS.eve],
  updatedAt: "2026-03-10T14:00:00Z",
};

// ── Mock proposals ──────────────────────────────────────────────────────

const MOCK_PROPOSALS: Proposal[] = [
  {
    id: "prop-001",
    forkId: "fork-main",
    title: "Upgrade quorum threshold to 50%",
    description:
      "Increase the governance quorum from 30% to 50% to ensure broader consensus on policy changes. This follows the recent incident where a low-turnout vote approved a controversial change.",
    author: WALLETS.alice,
    status: "approved",
    createdAt: "2026-03-12T09:00:00Z",
    updatedAt: "2026-03-15T10:00:00Z",
    votingEndsAt: "2026-03-14T09:00:00Z",
    votes: {
      for: 3,
      against: 0,
      abstain: 0,
      quorumReached: true,
      quorumRequired: 3000,
      threshold: "majority",
    },
    executionScopes: [
      {
        id: "scope-001",
        proposalId: "prop-001",
        scope: "governance.quorum.update",
        consumed: true,
        consumedAt: "2026-03-15T10:00:00Z",
        consumedBy: WALLETS.alice,
      },
    ],
    attestations: [
      {
        id: "att-001",
        forkId: "fork-main",
        proposalId: "prop-001",
        kind: "review_verdict",
        evidenceHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        attester: WALLETS.bob,
        timestamp: "2026-03-13T15:00:00Z",
        txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
        verified: true,
      },
    ],
    txHash: "0xaaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
  },
  {
    id: "prop-002",
    forkId: "fork-main",
    title: "Add consent gate for contract deployments",
    description:
      "Require 3 maintainer approvals before any smart contract deployment. This adds a new consent gate to the main fork policy to prevent unilateral contract changes.",
    author: WALLETS.bob,
    status: "active",
    createdAt: "2026-03-16T14:00:00Z",
    updatedAt: "2026-03-16T14:00:00Z",
    votingEndsAt: "2026-03-20T14:00:00Z",
    votes: {
      for: 2,
      against: 0,
      abstain: 1,
      quorumReached: false,
      quorumRequired: 5000,
      threshold: "majority",
    },
    executionScopes: [
      {
        id: "scope-002",
        proposalId: "prop-002",
        scope: "governance.consent_gate.add",
        consumed: false,
      },
    ],
    attestations: [
      {
        id: "att-002",
        forkId: "fork-main",
        proposalId: "prop-002",
        kind: "ci",
        evidenceHash: "0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba",
        attester: WALLETS.carol,
        timestamp: "2026-03-16T16:00:00Z",
        txHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
        verified: true,
      },
    ],
    txHash: "0xbbbb111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
  },
  {
    id: "prop-003",
    forkId: "fork-main",
    title: "Remove Dave from maintainer set",
    description:
      "Dave has transferred to a different team and is no longer actively maintaining this fork. This proposal removes his voting rights and maintainer status.",
    author: WALLETS.carol,
    status: "draft",
    createdAt: "2026-03-17T11:00:00Z",
    updatedAt: "2026-03-17T11:00:00Z",
    votingEndsAt: "2026-03-24T11:00:00Z",
    votes: {
      for: 0,
      against: 0,
      abstain: 0,
      quorumReached: false,
      quorumRequired: 5000,
      threshold: "supermajority",
    },
    executionScopes: [
      {
        id: "scope-003",
        proposalId: "prop-003",
        scope: "governance.maintainer.remove",
        consumed: false,
      },
    ],
    attestations: [],
    txHash: "0xcccc111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
  },
  {
    id: "prop-004",
    forkId: "fork-experimental",
    title: "Enable permissionless PR creation",
    description:
      "Allow any contributor to open PRs against the experimental fork without going through the consent gate. This accelerates development velocity at the cost of governance oversight.",
    author: WALLETS.dave,
    status: "rejected",
    createdAt: "2026-03-08T08:00:00Z",
    updatedAt: "2026-03-11T08:00:00Z",
    votingEndsAt: "2026-03-11T08:00:00Z",
    votes: {
      for: 0,
      against: 2,
      abstain: 0,
      quorumReached: true,
      quorumRequired: 3000,
      threshold: "majority",
    },
    executionScopes: [],
    attestations: [],
    txHash: "0xdddd111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
  },
];

// ── Mock forks ──────────────────────────────────────────────────────────

const MOCK_FORKS: Fork[] = [
  {
    id: "fork-main",
    name: "Main Governance",
    registryAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28",
    policy: POLICY_MAIN,
    maintainers: [WALLETS.alice, WALLETS.bob, WALLETS.carol],
    maintainerCount: 3,
    proposalCount: 3,
    attestationCount: 5,
    createdAt: "2026-01-15T10:00:00Z",
    lastActivityAt: "2026-03-17T11:00:00Z",
  },
  {
    id: "fork-experimental",
    name: "Experimental",
    registryAddress: "0x8Ba1f109551bD432803012645Ac136ddd64DBA72",
    policy: POLICY_EXPERIMENTAL,
    maintainers: [WALLETS.dave, WALLETS.eve],
    maintainerCount: 2,
    proposalCount: 1,
    attestationCount: 1,
    createdAt: "2026-02-20T14:00:00Z",
    lastActivityAt: "2026-03-11T08:00:00Z",
  },
];

// ── Mock timeline events ────────────────────────────────────────────────

const MOCK_TIMELINE: GovernanceTimelineEvent[] = [
  {
    id: "evt-001",
    type: "proposal_created",
    forkId: "fork-main",
    timestamp: "2026-03-17T11:00:00Z",
    actor: WALLETS.carol,
    summary: 'Proposal "Remove Dave from maintainer set" created',
    ref: { proposalId: "prop-003" },
    txHash: "0xcccc111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
  },
  {
    id: "evt-002",
    type: "vote_cast",
    forkId: "fork-main",
    timestamp: "2026-03-16T18:00:00Z",
    actor: WALLETS.carol,
    summary: "Voted ABSTAIN on proposal prop-002",
    ref: { proposalId: "prop-002" },
    txHash: "0xeeee111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
  },
  {
    id: "evt-003",
    type: "vote_cast",
    forkId: "fork-main",
    timestamp: "2026-03-16T17:00:00Z",
    actor: WALLETS.alice,
    summary: "Voted FOR on proposal prop-002",
    ref: { proposalId: "prop-002" },
    txHash: "0xffff111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
  },
  {
    id: "evt-004",
    type: "attestation_added",
    forkId: "fork-main",
    timestamp: "2026-03-16T16:00:00Z",
    actor: WALLETS.carol,
    summary: "CI attestation added for proposal prop-002",
    ref: { proposalId: "prop-002", attestationId: "att-002" },
    txHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
  },
  {
    id: "evt-005",
    type: "proposal_created",
    forkId: "fork-main",
    timestamp: "2026-03-16T14:00:00Z",
    actor: WALLETS.bob,
    summary: 'Proposal "Add consent gate for contract deployments" created',
    ref: { proposalId: "prop-002" },
    txHash: "0xbbbb111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
  },
  {
    id: "evt-006",
    type: "policy_updated",
    forkId: "fork-main",
    timestamp: "2026-03-15T10:00:00Z",
    actor: WALLETS.alice,
    summary: "Quorum threshold updated from 30% to 50%",
    ref: { forkId: "fork-main" },
    txHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
  },
  {
    id: "evt-007",
    type: "execution_consumed",
    forkId: "fork-main",
    timestamp: "2026-03-15T10:00:00Z",
    actor: WALLETS.alice,
    summary: "Execution scope governance.quorum.update consumed for prop-001",
    ref: { proposalId: "prop-001" },
    txHash: "0x4444444444444444444444444444444444444444444444444444444444444444",
  },
  {
    id: "evt-008",
    type: "proposal_status_changed",
    forkId: "fork-main",
    timestamp: "2026-03-15T09:30:00Z",
    actor: WALLETS.alice,
    summary: "Proposal prop-001 status changed to approved",
    ref: { proposalId: "prop-001" },
  },
  {
    id: "evt-009",
    type: "vote_cast",
    forkId: "fork-main",
    timestamp: "2026-03-13T16:00:00Z",
    actor: WALLETS.bob,
    summary: "Voted FOR on proposal prop-001",
    ref: { proposalId: "prop-001" },
    txHash: "0x5555555555555555555555555555555555555555555555555555555555555555",
  },
  {
    id: "evt-010",
    type: "proposal_status_changed",
    forkId: "fork-experimental",
    timestamp: "2026-03-11T08:00:00Z",
    actor: WALLETS.dave,
    summary: "Proposal prop-004 status changed to rejected",
    ref: { proposalId: "prop-004" },
  },
  {
    id: "evt-011",
    type: "fork_created",
    forkId: "fork-experimental",
    timestamp: "2026-02-20T14:00:00Z",
    actor: WALLETS.dave,
    summary: "Fork 'Experimental' created",
    ref: { forkId: "fork-experimental" },
    txHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
  },
];

// ── Mock votes ──────────────────────────────────────────────────────────

const MOCK_VOTES: Vote[] = [
  {
    voter: WALLETS.alice,
    proposalId: "prop-001",
    choice: "for",
    timestamp: "2026-03-13T14:00:00Z",
    txHash: "0x7777777777777777777777777777777777777777777777777777777777777777",
  },
  {
    voter: WALLETS.bob,
    proposalId: "prop-001",
    choice: "for",
    timestamp: "2026-03-13T16:00:00Z",
    txHash: "0x5555555555555555555555555555555555555555555555555555555555555555",
  },
  {
    voter: WALLETS.carol,
    proposalId: "prop-001",
    choice: "for",
    timestamp: "2026-03-14T08:00:00Z",
    txHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
  },
  {
    voter: WALLETS.alice,
    proposalId: "prop-002",
    choice: "for",
    timestamp: "2026-03-16T17:00:00Z",
    txHash: "0xffff111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
  },
  {
    voter: WALLETS.bob,
    proposalId: "prop-002",
    choice: "for",
    timestamp: "2026-03-16T17:30:00Z",
    txHash: "0x9999999999999999999999999999999999999999999999999999999999999999",
  },
  {
    voter: WALLETS.carol,
    proposalId: "prop-002",
    choice: "abstain",
    timestamp: "2026-03-16T18:00:00Z",
    txHash: "0xeeee111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
  },
  {
    voter: WALLETS.dave,
    proposalId: "prop-004",
    choice: "against",
    timestamp: "2026-03-09T10:00:00Z",
    txHash: "0xaaaa999988887777666655554444333322221111aaaa999988887777666655",
  },
  {
    voter: WALLETS.eve,
    proposalId: "prop-004",
    choice: "against",
    timestamp: "2026-03-10T09:00:00Z",
    txHash: "0xbbbb999988887777666655554444333322221111aaaa999988887777666655",
  },
];

// ── Public API ──────────────────────────────────────────────────────────

export function getProposals(): Proposal[] {
  return MOCK_PROPOSALS;
}

export function getProposal(id: string): Proposal | undefined {
  return MOCK_PROPOSALS.find((p) => p.id === id);
}

export function getProposalVotes(proposalId: string): Vote[] {
  return MOCK_VOTES.filter((v) => v.proposalId === proposalId);
}

export function getForks(): Fork[] {
  return MOCK_FORKS;
}

export function getFork(id: string): Fork | undefined {
  return MOCK_FORKS.find((f) => f.id === id);
}

export function getForkPolicy(forkId: string): GovernancePolicy | undefined {
  return MOCK_FORKS.find((f) => f.id === forkId)?.policy;
}

export function getTimeline(forkId?: string): GovernanceTimelineEvent[] {
  if (forkId) {
    return MOCK_TIMELINE.filter((e) => e.forkId === forkId);
  }
  return MOCK_TIMELINE;
}

export function getGovernanceSnapshot(forkId?: string): GovernanceSSESnapshot {
  return {
    type: "governance_snapshot",
    emittedAt: new Date().toISOString(),
    proposals: forkId ? MOCK_PROPOSALS.filter((p) => p.forkId === forkId) : MOCK_PROPOSALS,
    forks: forkId ? MOCK_FORKS.filter((f) => f.id === forkId) : MOCK_FORKS,
    timeline: getTimeline(forkId),
  };
}

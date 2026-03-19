import { describe, it, expect } from "vitest";
import {
  sortProposalsByStatus,
  getProposalStatusColor,
  getEventTypeLabel,
  getEventTypeColor,
  formatAddress,
  getVotePercentage,
  isVotingOpen,
  type Proposal,
  type VoteTally,
  type GovernanceEventType,
} from "../governance-types";

function createProposal(overrides?: Partial<Proposal>): Proposal {
  return {
    id: "prop-test",
    forkId: "fork-main",
    title: "Test Proposal",
    description: "A test proposal",
    author: "0x1234567890abcdef1234567890abcdef12345678",
    status: "active",
    createdAt: "2026-03-12T09:00:00Z",
    updatedAt: "2026-03-12T09:00:00Z",
    votingEndsAt: "2026-03-20T09:00:00Z",
    votes: {
      for: 2,
      against: 1,
      abstain: 0,
      quorumReached: true,
      quorumRequired: 5000,
      threshold: "majority",
    },
    executionScopes: [],
    attestations: [],
    txHash: "0xabcd",
    ...overrides,
  };
}

describe("sortProposalsByStatus", () => {
  it("sorts active proposals first, then by updatedAt descending", () => {
    const proposals = [
      createProposal({ id: "p1", status: "executed", updatedAt: "2026-03-10T00:00:00Z" }),
      createProposal({ id: "p2", status: "active", updatedAt: "2026-03-11T00:00:00Z" }),
      createProposal({ id: "p3", status: "draft", updatedAt: "2026-03-12T00:00:00Z" }),
      createProposal({ id: "p4", status: "active", updatedAt: "2026-03-13T00:00:00Z" }),
    ];
    const sorted = sortProposalsByStatus(proposals);
    expect(sorted.map((p) => p.id)).toEqual(["p4", "p2", "p3", "p1"]);
  });

  it("returns empty array for empty input", () => {
    expect(sortProposalsByStatus([])).toEqual([]);
  });
});

describe("getProposalStatusColor", () => {
  it("returns correct colors for each status", () => {
    expect(getProposalStatusColor("draft")).toBe("var(--color-text-muted)");
    expect(getProposalStatusColor("active")).toBe("var(--color-status-working)");
    expect(getProposalStatusColor("approved")).toBe("var(--color-status-ready)");
    expect(getProposalStatusColor("rejected")).toBe("var(--color-status-error)");
    expect(getProposalStatusColor("executed")).toBe("var(--color-accent-violet)");
    expect(getProposalStatusColor("cancelled")).toBe("var(--color-text-tertiary)");
  });
});

describe("getEventTypeLabel", () => {
  it("returns human-readable labels for all event types", () => {
    const types: GovernanceEventType[] = [
      "proposal_created",
      "proposal_status_changed",
      "vote_cast",
      "policy_updated",
      "attestation_added",
      "fork_created",
      "execution_consumed",
    ];
    for (const type of types) {
      const label = getEventTypeLabel(type);
      expect(label).toBeTruthy();
      expect(typeof label).toBe("string");
    }
  });
});

describe("getEventTypeColor", () => {
  it("returns a CSS variable string for each event type", () => {
    const types: GovernanceEventType[] = [
      "proposal_created",
      "proposal_status_changed",
      "vote_cast",
      "policy_updated",
      "attestation_added",
      "fork_created",
      "execution_consumed",
    ];
    for (const type of types) {
      const color = getEventTypeColor(type);
      expect(color).toMatch(/^var\(--color-/);
    }
  });
});

describe("formatAddress", () => {
  it("truncates a full Ethereum address", () => {
    const result = formatAddress("0x1234567890abcdef1234567890abcdef12345678");
    expect(result).toBe("0x1234...5678");
  });

  it("returns short addresses unchanged", () => {
    expect(formatAddress("0x1234")).toBe("0x1234");
  });

  it("returns 10-char addresses unchanged", () => {
    expect(formatAddress("0x12345678")).toBe("0x12345678");
  });
});

describe("getVotePercentage", () => {
  it("calculates correct percentages", () => {
    const tally: VoteTally = {
      for: 6,
      against: 3,
      abstain: 1,
      quorumReached: true,
      quorumRequired: 5000,
      threshold: "majority",
    };
    const pct = getVotePercentage(tally);
    expect(pct.for).toBe(60);
    expect(pct.against).toBe(30);
    expect(pct.abstain).toBe(10);
  });

  it("returns zeros when no votes cast", () => {
    const tally: VoteTally = {
      for: 0,
      against: 0,
      abstain: 0,
      quorumReached: false,
      quorumRequired: 5000,
      threshold: "majority",
    };
    const pct = getVotePercentage(tally);
    expect(pct.for).toBe(0);
    expect(pct.against).toBe(0);
    expect(pct.abstain).toBe(0);
  });

  it("handles unanimous votes", () => {
    const tally: VoteTally = {
      for: 5,
      against: 0,
      abstain: 0,
      quorumReached: true,
      quorumRequired: 5000,
      threshold: "majority",
    };
    const pct = getVotePercentage(tally);
    expect(pct.for).toBe(100);
    expect(pct.against).toBe(0);
    expect(pct.abstain).toBe(0);
  });
});

describe("isVotingOpen", () => {
  it("returns true for active proposal with future deadline", () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const proposal = createProposal({ status: "active", votingEndsAt: future });
    expect(isVotingOpen(proposal)).toBe(true);
  });

  it("returns false for active proposal with past deadline", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const proposal = createProposal({ status: "active", votingEndsAt: past });
    expect(isVotingOpen(proposal)).toBe(false);
  });

  it("returns false for non-active proposal even with future deadline", () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const proposal = createProposal({ status: "approved", votingEndsAt: future });
    expect(isVotingOpen(proposal)).toBe(false);
  });

  it("returns false for draft proposal", () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const proposal = createProposal({ status: "draft", votingEndsAt: future });
    expect(isVotingOpen(proposal)).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  getProposals,
  getProposal,
  getProposalVotes,
  getForks,
  getFork,
  getForkPolicy,
  getTimeline,
  getGovernanceSnapshot,
} from "../governance-mock";

describe("governance mock data", () => {
  describe("getProposals", () => {
    it("returns a non-empty array of proposals", () => {
      const proposals = getProposals();
      expect(proposals.length).toBeGreaterThan(0);
    });

    it("each proposal has required fields", () => {
      for (const p of getProposals()) {
        expect(p.id).toBeTruthy();
        expect(p.forkId).toBeTruthy();
        expect(p.title).toBeTruthy();
        expect(p.status).toBeTruthy();
        expect(p.txHash).toBeTruthy();
      }
    });
  });

  describe("getProposal", () => {
    it("returns proposal by id", () => {
      const proposal = getProposal("prop-001");
      expect(proposal).toBeDefined();
      expect(proposal!.id).toBe("prop-001");
    });

    it("returns undefined for unknown id", () => {
      expect(getProposal("nonexistent")).toBeUndefined();
    });
  });

  describe("getProposalVotes", () => {
    it("returns votes for a proposal", () => {
      const votes = getProposalVotes("prop-001");
      expect(votes.length).toBeGreaterThan(0);
      for (const v of votes) {
        expect(v.proposalId).toBe("prop-001");
        expect(["for", "against", "abstain"]).toContain(v.choice);
      }
    });

    it("returns empty array for proposal with no votes", () => {
      const votes = getProposalVotes("nonexistent");
      expect(votes).toEqual([]);
    });
  });

  describe("getForks", () => {
    it("returns a non-empty array of forks", () => {
      const forks = getForks();
      expect(forks.length).toBeGreaterThan(0);
    });

    it("each fork has a policy", () => {
      for (const f of getForks()) {
        expect(f.policy).toBeDefined();
        expect(f.policy.quorum).toBeGreaterThan(0);
        expect(f.policy.threshold).toBeTruthy();
      }
    });
  });

  describe("getFork", () => {
    it("returns fork by id", () => {
      const fork = getFork("fork-main");
      expect(fork).toBeDefined();
      expect(fork!.name).toBe("Main Governance");
    });

    it("returns undefined for unknown id", () => {
      expect(getFork("nonexistent")).toBeUndefined();
    });
  });

  describe("getForkPolicy", () => {
    it("returns policy for existing fork", () => {
      const policy = getForkPolicy("fork-main");
      expect(policy).toBeDefined();
      expect(policy!.consentGates.length).toBeGreaterThan(0);
    });

    it("main fork policy has a previous version for diff", () => {
      const policy = getForkPolicy("fork-main");
      expect(policy!.previous).toBeDefined();
      expect(policy!.previous!.quorum).not.toBe(policy!.quorum);
    });

    it("returns undefined for unknown fork", () => {
      expect(getForkPolicy("nonexistent")).toBeUndefined();
    });
  });

  describe("getTimeline", () => {
    it("returns all events when no fork filter", () => {
      const events = getTimeline();
      expect(events.length).toBeGreaterThan(0);
    });

    it("filters events by fork id", () => {
      const events = getTimeline("fork-main");
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(e.forkId).toBe("fork-main");
      }
    });

    it("returns events sorted by timestamp (descending is expected by consumer)", () => {
      const events = getTimeline();
      // Events should be pre-sorted newest first
      for (let i = 1; i < events.length; i++) {
        expect(events[i - 1].timestamp >= events[i].timestamp).toBe(true);
      }
    });
  });

  describe("getGovernanceSnapshot", () => {
    it("returns a snapshot with correct type", () => {
      const snapshot = getGovernanceSnapshot();
      expect(snapshot.type).toBe("governance_snapshot");
      expect(snapshot.emittedAt).toBeTruthy();
      expect(Array.isArray(snapshot.proposals)).toBe(true);
      expect(Array.isArray(snapshot.forks)).toBe(true);
      expect(Array.isArray(snapshot.timeline)).toBe(true);
    });

    it("filters by fork", () => {
      const snapshot = getGovernanceSnapshot("fork-experimental");
      for (const p of snapshot.proposals) {
        expect(p.forkId).toBe("fork-experimental");
      }
      for (const f of snapshot.forks) {
        expect(f.id).toBe("fork-experimental");
      }
    });
  });
});

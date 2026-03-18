import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted to define mocks that can be referenced inside vi.mock factories
const {
  mockGetChainId,
  mockGetBlockNumber,
  mockWaitForTransactionReceipt,
  mockWriteContract,
  mockGetProposalState,
  mockIsScopeAllowed,
  mockIsScopeConsumed,
  defaultContractRead,
  votingContractRead,
  executionContractRead,
  attestationContractRead,
} = vi.hoisted(() => {
  const mockGetChainId = vi.fn().mockResolvedValue(8453);
  const mockGetBlockNumber = vi.fn().mockResolvedValue(12345678n);
  const mockWaitForTransactionReceipt = vi.fn().mockResolvedValue({ logs: [] });
  const mockWriteContract = vi.fn().mockResolvedValue("0xdeadbeef");

  const mockGetProposalState = vi.fn();
  const mockIsScopeAllowed = vi.fn();
  const mockIsScopeConsumed = vi.fn();

  const defaultContractRead = {
    getProposal: vi.fn().mockResolvedValue({
      contentHash: "0x" + "aa".repeat(32),
      forkId: "0x" + "bb".repeat(32),
      proposer: "0x" + "11".repeat(20),
      createdAt: 1700000000n,
      status: 0,
    }),
    defaultForkId: vi.fn().mockResolvedValue("0x" + "bb".repeat(32)),
    proposalIdsByFork: vi.fn().mockResolvedValue([1n, 2n]),
    nextProposalId: vi.fn().mockResolvedValue(3n),
    proposalStatus: vi.fn().mockResolvedValue(0),
    proposalForkId: vi.fn().mockResolvedValue("0x" + "bb".repeat(32)),
    proposalCountByFork: vi.fn().mockResolvedValue(2n),
  };

  const votingContractRead = {
    getVoteTally: vi.fn().mockResolvedValue({
      forVotes: 3,
      againstVotes: 1,
      abstainVotes: 0,
    }),
    proposalResult: vi.fn().mockResolvedValue([true, true, true]),
    isApproved: vi.fn().mockResolvedValue(true),
    defaultForkId: vi.fn().mockResolvedValue("0x" + "bb".repeat(32)),
    isMaintainer: vi.fn().mockResolvedValue(true),
    maintainerCount: vi.fn().mockResolvedValue(5n),
    maintainers: vi.fn().mockResolvedValue([]),
    getForkPolicy: vi.fn().mockResolvedValue({ quorumBps: 5000, threshold: 0, exists: true }),
    hasMaintainerVoted: vi.fn().mockResolvedValue(false),
  };

  const executionContractRead = {
    getProposalState: mockGetProposalState,
    isScopeAllowed: mockIsScopeAllowed,
    isScopeConsumed: mockIsScopeConsumed,
    CONSENT_GATE_SCOPE: vi.fn().mockResolvedValue("0x" + "ff".repeat(32)),
    proposalScopes: vi.fn().mockResolvedValue([]),
  };

  const attestationContractRead = {
    getAttestation: vi.fn().mockResolvedValue({
      forkId: "0x" + "bb".repeat(32),
      proposalId: 1n,
      evidenceHash: "0x" + "cc".repeat(32),
      kind: 0,
      attester: "0x" + "11".repeat(20),
      timestamp: 1700000000n,
    }),
    totalAttestations: vi.fn().mockResolvedValue(5n),
    attestationIdsByFork: vi.fn().mockResolvedValue([0n, 1n]),
    attestationIdsByProposal: vi.fn().mockResolvedValue([0n]),
  };

  return {
    mockGetChainId,
    mockGetBlockNumber,
    mockWaitForTransactionReceipt,
    mockWriteContract,
    mockGetProposalState,
    mockIsScopeAllowed,
    mockIsScopeConsumed,
    defaultContractRead,
    votingContractRead,
    executionContractRead,
    attestationContractRead,
  };
});

let getContractCallCount = 0;

vi.mock("viem", () => ({
  createPublicClient: vi.fn().mockReturnValue({
    getChainId: mockGetChainId,
    getBlockNumber: mockGetBlockNumber,
    waitForTransactionReceipt: mockWaitForTransactionReceipt,
  }),
  createWalletClient: vi.fn().mockReturnValue({
    writeContract: mockWriteContract,
  }),
  http: vi.fn().mockReturnValue("http-transport"),
  getContract: vi.fn().mockImplementation(() => {
    getContractCallCount++;
    // Contracts are created in order: registry, voting, execution, attestation
    switch (getContractCallCount % 4) {
      case 1:
        return { read: defaultContractRead };
      case 2:
        return { read: votingContractRead };
      case 3:
        return { read: executionContractRead };
      case 0:
        return { read: attestationContractRead };
      default:
        return { read: {} };
    }
  }),
  decodeEventLog: vi.fn().mockReturnValue({ eventName: "Unknown", args: {} }),
}));

vi.mock("viem/chains", () => ({
  base: { id: 8453, name: "Base" },
}));

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: vi.fn().mockReturnValue({
    address: "0x1234567890abcdef1234567890abcdef12345678",
    type: "local",
  }),
}));

import { manifest, create } from "../index.js";

const TEST_CONTRACTS = {
  governanceRegistry: "0x1111111111111111111111111111111111111111",
  votingPolicy: "0x2222222222222222222222222222222222222222",
  executionPolicy: "0x3333333333333333333333333333333333333333",
  attestationLog: "0x4444444444444444444444444444444444444444",
};

const TEST_FORK_ID = "0x" + "bb".repeat(32);

describe("governance-chain plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getContractCallCount = 0;
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("base");
      expect(manifest.slot).toBe("governance");
      expect(manifest.version).toBe("0.1.0");
      expect(manifest.description).toContain("Base");
    });
  });

  describe("create()", () => {
    it("throws without config", () => {
      expect(() => create()).toThrow("requires config");
    });

    it("throws without contract addresses", () => {
      expect(() => create({})).toThrow("requires config.contracts");
    });

    it("creates adapter with valid config and private key", () => {
      const adapter = create({
        contracts: TEST_CONTRACTS,
        privateKey: "0x" + "ab".repeat(32),
        rpcUrl: "https://base-rpc.example.com",
      });
      expect(adapter.name).toBe("base");
    });

    it("creates adapter without private key (read-only mode)", () => {
      const adapter = create({
        contracts: TEST_CONTRACTS,
        rpcUrl: "https://base-rpc.example.com",
      });
      expect(adapter.name).toBe("base");
    });
  });

  describe("chain info", () => {
    it("getChainId returns Base chain ID", async () => {
      const adapter = create({
        contracts: TEST_CONTRACTS,
        rpcUrl: "https://base-rpc.example.com",
      });
      const chainId = await adapter.getChainId();
      expect(chainId).toBe(8453);
    });

    it("getBlockNumber returns current block number", async () => {
      const adapter = create({
        contracts: TEST_CONTRACTS,
        rpcUrl: "https://base-rpc.example.com",
      });
      const blockNumber = await adapter.getBlockNumber();
      expect(blockNumber).toBe(12345678);
    });
  });

  describe("proposals (read)", () => {
    it("getProposal returns parsed proposal", async () => {
      const adapter = create({
        contracts: TEST_CONTRACTS,
        rpcUrl: "https://base-rpc.example.com",
      });
      const proposal = await adapter.getProposal(1);
      expect(proposal.id).toBe(1);
      expect(proposal.status).toBe("draft");
      expect(proposal.contentHash).toBe("0x" + "aa".repeat(32));
      expect(proposal.createdAt).toBeInstanceOf(Date);
    });

    it("listProposals returns array of proposals", async () => {
      const adapter = create({
        contracts: TEST_CONTRACTS,
        rpcUrl: "https://base-rpc.example.com",
      });
      const proposals = await adapter.listProposals(TEST_FORK_ID);
      expect(proposals).toHaveLength(2);
      expect(proposals[0]!.id).toBe(1);
      expect(proposals[1]!.id).toBe(2);
    });
  });

  describe("voting (read)", () => {
    it("getVoteRecord returns tally and result", async () => {
      const adapter = create({
        contracts: TEST_CONTRACTS,
        rpcUrl: "https://base-rpc.example.com",
      });
      const record = await adapter.getVoteRecord(TEST_FORK_ID, 1);
      expect(record.forVotes).toBe(3);
      expect(record.againstVotes).toBe(1);
      expect(record.abstainVotes).toBe(0);
      expect(record.approved).toBe(true);
      expect(record.quorumMet).toBe(true);
      expect(record.thresholdMet).toBe(true);
    });
  });

  describe("checkAuthorization", () => {
    it("returns authorized when all checks pass", async () => {
      mockGetProposalState.mockResolvedValue({
        forkId: TEST_FORK_ID,
        scopesDefined: true,
        approved: true,
      });
      mockIsScopeAllowed.mockResolvedValue(true);
      mockIsScopeConsumed.mockResolvedValue(false);

      const adapter = create({
        contracts: TEST_CONTRACTS,
        rpcUrl: "https://base-rpc.example.com",
      });
      const result = await adapter.checkAuthorization({
        proposalId: 1,
        scope: "0x" + "cc".repeat(32),
      });
      expect(result.authorized).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("returns not authorized when scopes not defined", async () => {
      mockGetProposalState.mockResolvedValue({
        forkId: TEST_FORK_ID,
        scopesDefined: false,
        approved: false,
      });

      const adapter = create({
        contracts: TEST_CONTRACTS,
        rpcUrl: "https://base-rpc.example.com",
      });
      const result = await adapter.checkAuthorization({
        proposalId: 1,
        scope: "0x" + "cc".repeat(32),
      });
      expect(result.authorized).toBe(false);
      expect(result.reason).toContain("No execution scopes defined");
    });

    it("returns not authorized when proposal not approved", async () => {
      mockGetProposalState.mockResolvedValue({
        forkId: TEST_FORK_ID,
        scopesDefined: true,
        approved: false,
      });

      const adapter = create({
        contracts: TEST_CONTRACTS,
        rpcUrl: "https://base-rpc.example.com",
      });
      const result = await adapter.checkAuthorization({
        proposalId: 1,
        scope: "0x" + "cc".repeat(32),
      });
      expect(result.authorized).toBe(false);
      expect(result.reason).toContain("not approved for execution");
    });

    it("returns not authorized when scope not allowed", async () => {
      mockGetProposalState.mockResolvedValue({
        forkId: TEST_FORK_ID,
        scopesDefined: true,
        approved: true,
      });
      mockIsScopeAllowed.mockResolvedValue(false);

      const adapter = create({
        contracts: TEST_CONTRACTS,
        rpcUrl: "https://base-rpc.example.com",
      });
      const result = await adapter.checkAuthorization({
        proposalId: 1,
        scope: "0x" + "cc".repeat(32),
      });
      expect(result.authorized).toBe(false);
      expect(result.reason).toContain("not allowed");
    });

    it("returns not authorized when scope already consumed", async () => {
      mockGetProposalState.mockResolvedValue({
        forkId: TEST_FORK_ID,
        scopesDefined: true,
        approved: true,
      });
      mockIsScopeAllowed.mockResolvedValue(true);
      mockIsScopeConsumed.mockResolvedValue(true);

      const adapter = create({
        contracts: TEST_CONTRACTS,
        rpcUrl: "https://base-rpc.example.com",
      });
      const result = await adapter.checkAuthorization({
        proposalId: 1,
        scope: "0x" + "cc".repeat(32),
      });
      expect(result.authorized).toBe(false);
      expect(result.reason).toContain("already been consumed");
    });
  });

  describe("attestation (read)", () => {
    it("verifyAttestation returns parsed attestation", async () => {
      const adapter = create({
        contracts: TEST_CONTRACTS,
        rpcUrl: "https://base-rpc.example.com",
      });
      const att = await adapter.verifyAttestation(0);
      expect(att.id).toBe(0);
      expect(att.kind).toBe("ci");
      expect(att.proposalId).toBe(1);
      expect(att.timestamp).toBeInstanceOf(Date);
    });
  });

  describe("write operations without wallet", () => {
    it("submitProposal throws without wallet", async () => {
      const adapter = create({
        contracts: TEST_CONTRACTS,
        rpcUrl: "https://base-rpc.example.com",
      });
      await expect(
        adapter.submitProposal({ contentHash: "0x" + "aa".repeat(32) }),
      ).rejects.toThrow("Write operations require a private key");
    });

    it("castVote throws without wallet", async () => {
      const adapter = create({
        contracts: TEST_CONTRACTS,
        rpcUrl: "https://base-rpc.example.com",
      });
      await expect(
        adapter.castVote({ proposalId: 1, choice: "for" }),
      ).rejects.toThrow("Write operations require a private key");
    });

    it("attest throws without wallet", async () => {
      const adapter = create({
        contracts: TEST_CONTRACTS,
        rpcUrl: "https://base-rpc.example.com",
      });
      await expect(
        adapter.attest({
          forkId: TEST_FORK_ID,
          proposalId: 1,
          kind: "ci",
          evidenceHash: "0x" + "bb".repeat(32),
        }),
      ).rejects.toThrow("Write operations require a private key");
    });
  });

  describe("write operations with wallet", () => {
    it("submitProposal calls writeContract and returns result", async () => {
      const adapter = create({
        contracts: TEST_CONTRACTS,
        privateKey: "0x" + "ab".repeat(32),
        rpcUrl: "https://base-rpc.example.com",
      });
      const result = await adapter.submitProposal({
        contentHash: "0x" + "aa".repeat(32),
      });
      expect(result.transactionHash).toBe("0xdeadbeef");
      expect(mockWriteContract).toHaveBeenCalled();
    });

    it("castVote calls writeContract and returns result", async () => {
      const adapter = create({
        contracts: TEST_CONTRACTS,
        privateKey: "0x" + "ab".repeat(32),
        rpcUrl: "https://base-rpc.example.com",
      });
      const result = await adapter.castVote({ proposalId: 1, choice: "for" });
      expect(result.transactionHash).toBe("0xdeadbeef");
      expect(mockWriteContract).toHaveBeenCalled();
    });

    it("attest calls writeContract and returns result", async () => {
      const adapter = create({
        contracts: TEST_CONTRACTS,
        privateKey: "0x" + "ab".repeat(32),
        rpcUrl: "https://base-rpc.example.com",
      });
      const result = await adapter.attest({
        forkId: TEST_FORK_ID,
        proposalId: 1,
        kind: "ci",
        evidenceHash: "0x" + "bb".repeat(32),
      });
      expect(result.transactionHash).toBe("0xdeadbeef");
      expect(mockWriteContract).toHaveBeenCalled();
    });
  });

  describe("default export", () => {
    it("satisfies PluginModule shape", async () => {
      const mod = await import("../index.js");
      expect(mod.default.manifest).toBeDefined();
      expect(mod.default.manifest.slot).toBe("governance");
      expect(typeof mod.default.create).toBe("function");
    });
  });
});

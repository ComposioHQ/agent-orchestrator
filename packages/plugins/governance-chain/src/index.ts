import type {
  PluginModule,
  GovernanceChain,
  GovernanceContractAddresses,
  GovernanceProposal,
  GovernanceProposalResult,
  GovernanceVoteRecord,
  GovernanceAttestation,
  SubmitProposalParams,
  CastVoteParams,
  CastVoteResult,
  CheckAuthorizationParams,
  AuthorizationResult,
  AttestParams,
  AttestResult,
} from "@composio/ao-core";
import {
  GOVERNANCE_PROPOSAL_STATUS,
  GOVERNANCE_VOTE_CHOICE,
  GOVERNANCE_ATTESTATION_KIND,
} from "@composio/ao-core";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
  type Hex,
  getContract,
  decodeEventLog,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  governanceRegistryAbi,
  votingPolicyAbi,
  executionPolicyAbi,
  attestationLogAbi,
} from "./abi.js";

export const manifest = {
  name: "base",
  slot: "governance" as const,
  description: "Governance plugin: on-chain governance bridge for Base (chain 8453)",
  version: "0.1.0",
};

/** Maps Solidity ProposalStatus enum (uint8) to our string literal (uses core constants) */
const PROPOSAL_STATUS_MAP = [
  GOVERNANCE_PROPOSAL_STATUS.DRAFT,
  GOVERNANCE_PROPOSAL_STATUS.ACTIVE,
  GOVERNANCE_PROPOSAL_STATUS.APPROVED,
  GOVERNANCE_PROPOSAL_STATUS.REJECTED,
  GOVERNANCE_PROPOSAL_STATUS.EXECUTED,
  GOVERNANCE_PROPOSAL_STATUS.CANCELLED,
] as const;

/** Maps our vote choice string to Solidity VoteChoice enum (uint8) */
const VOTE_CHOICE_TO_UINT = {
  [GOVERNANCE_VOTE_CHOICE.AGAINST]: 0,
  [GOVERNANCE_VOTE_CHOICE.FOR]: 1,
  [GOVERNANCE_VOTE_CHOICE.ABSTAIN]: 2,
} as const;

/** Maps Solidity AttestationKind enum (uint8) to our string literal (uses core constants) */
const ATTESTATION_KIND_MAP = [
  GOVERNANCE_ATTESTATION_KIND.CI,
  GOVERNANCE_ATTESTATION_KIND.REVIEW_VERDICT,
  GOVERNANCE_ATTESTATION_KIND.CONVERGENCE_PATTERN,
  GOVERNANCE_ATTESTATION_KIND.CUSTOM,
] as const;

/** Maps our attestation kind string to Solidity enum (uint8) */
const ATTESTATION_KIND_TO_UINT = {
  [GOVERNANCE_ATTESTATION_KIND.CI]: 0,
  [GOVERNANCE_ATTESTATION_KIND.REVIEW_VERDICT]: 1,
  [GOVERNANCE_ATTESTATION_KIND.CONVERGENCE_PATTERN]: 2,
  [GOVERNANCE_ATTESTATION_KIND.CUSTOM]: 3,
} as const;

export interface BaseAdapterConfig {
  /** JSON-RPC URL for Base (defaults to public Base RPC) */
  rpcUrl?: string;
  /** Private key for signing transactions (hex-encoded, with or without 0x prefix) */
  privateKey?: string;
  /** Contract addresses for the governance deployment */
  contracts: GovernanceContractAddresses;
  /** Custom chain config (defaults to Base mainnet, chain ID 8453) */
  chain?: Chain;
}

function isHexAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function validateContractAddresses(
  contracts: unknown,
): GovernanceContractAddresses {
  if (!contracts || typeof contracts !== "object") {
    throw new Error(
      "governance-chain plugin requires config.contracts as an object with contract addresses",
    );
  }
  const c = contracts as Record<string, unknown>;
  const required = [
    "governanceRegistry",
    "votingPolicy",
    "executionPolicy",
    "attestationLog",
  ] as const;
  for (const field of required) {
    if (!isHexAddress(c[field])) {
      throw new Error(
        `governance-chain plugin: config.contracts.${field} must be a valid 0x-prefixed Ethereum address`,
      );
    }
  }
  return c as unknown as GovernanceContractAddresses;
}

export function create(config?: Record<string, unknown>): GovernanceChain {
  if (!config) {
    throw new Error("governance-chain plugin requires config with contract addresses");
  }

  const contracts = validateContractAddresses(config["contracts"]);

  const chain = (config["chain"] as Chain | undefined) ?? base;
  const rpcUrl = (config["rpcUrl"] as string | undefined) ?? process.env["BASE_RPC_URL"];
  const privateKey =
    (config["privateKey"] as string | undefined) ?? process.env["GOVERNANCE_PRIVATE_KEY"];

  const transport = http(rpcUrl);

  const publicClient = createPublicClient({ chain, transport });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let walletClient: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let account: any = null;

  if (privateKey) {
    const normalizedKey = (
      privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`
    ) as Hex;
    account = privateKeyToAccount(normalizedKey);
    walletClient = createWalletClient({ chain, transport, account });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function requireWallet(): { wallet: any; account: any } {
    if (!walletClient || !account) {
      throw new Error(
        "Write operations require a private key. Set GOVERNANCE_PRIVATE_KEY or pass privateKey in config.",
      );
    }
    return { wallet: walletClient, account };
  }

  const registry = getContract({
    address: contracts.governanceRegistry as Hex,
    abi: governanceRegistryAbi,
    client: publicClient,
  });

  const voting = getContract({
    address: contracts.votingPolicy as Hex,
    abi: votingPolicyAbi,
    client: publicClient,
  });

  const execution = getContract({
    address: contracts.executionPolicy as Hex,
    abi: executionPolicyAbi,
    client: publicClient,
  });

  const attestationContract = getContract({
    address: contracts.attestationLog as Hex,
    abi: attestationLogAbi,
    client: publicClient,
  });

  function parseProposal(
    id: number,
    raw: { contentHash: Hex; forkId: Hex; proposer: Hex; createdAt: bigint; status: number },
  ): GovernanceProposal {
    return {
      id,
      contentHash: raw.contentHash,
      forkId: raw.forkId,
      proposer: raw.proposer,
      createdAt: new Date(Number(raw.createdAt) * 1000),
      status: PROPOSAL_STATUS_MAP[raw.status] ?? "draft",
    };
  }

  function parseAttestation(
    id: number,
    raw: {
      forkId: Hex;
      proposalId: bigint;
      evidenceHash: Hex;
      kind: number;
      attester: Hex;
      timestamp: bigint;
    },
  ): GovernanceAttestation {
    return {
      id,
      forkId: raw.forkId,
      proposalId: Number(raw.proposalId),
      evidenceHash: raw.evidenceHash,
      kind: ATTESTATION_KIND_MAP[raw.kind] ?? "custom",
      attester: raw.attester,
      timestamp: new Date(Number(raw.timestamp) * 1000),
    };
  }

  return {
    name: "base",

    // --- Proposal Management ---

    async submitProposal(params: SubmitProposalParams): Promise<GovernanceProposalResult> {
      const { wallet, account: acc } = requireWallet();

      const contentHash = params.contentHash as Hex;
      let txHash: Hex;

      if (params.forkId) {
        txHash = await wallet.writeContract({
          address: contracts.governanceRegistry as Hex,
          abi: governanceRegistryAbi,
          functionName: "createProposalForFork",
          args: [params.forkId as Hex, contentHash],
          account: acc,
        });
      } else {
        txHash = await wallet.writeContract({
          address: contracts.governanceRegistry as Hex,
          abi: governanceRegistryAbi,
          functionName: "createProposal",
          args: [contentHash],
          account: acc,
        });
      }

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: governanceRegistryAbi,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "ProposalCreated") {
            return {
              proposalId: Number(
                (decoded.args as { proposalId: bigint }).proposalId,
              ),
              transactionHash: txHash,
            };
          }
        } catch {
          // Not a matching event, skip
        }
      }

      throw new Error(
        `Transaction ${txHash} succeeded but ProposalCreated event not found in receipt logs`,
      );
    },

    async getProposal(proposalId: number): Promise<GovernanceProposal> {
      const raw = await registry.read.getProposal([BigInt(proposalId)]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return parseProposal(proposalId, raw as any);
    },

    async listProposals(forkId?: string): Promise<GovernanceProposal[]> {
      const targetForkId = forkId
        ? (forkId as Hex)
        : ((await registry.read.defaultForkId()) as Hex);

      const ids = (await registry.read.proposalIdsByFork([targetForkId])) as readonly bigint[];

      const proposals: GovernanceProposal[] = [];
      for (const id of ids) {
        const raw = await registry.read.getProposal([id]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        proposals.push(parseProposal(Number(id), raw as any));
      }
      return proposals;
    },

    // --- Voting ---

    async castVote(params: CastVoteParams): Promise<CastVoteResult> {
      const { wallet, account: acc } = requireWallet();
      const choiceUint = VOTE_CHOICE_TO_UINT[params.choice];

      let txHash: Hex;
      if (params.forkId) {
        txHash = await wallet.writeContract({
          address: contracts.votingPolicy as Hex,
          abi: votingPolicyAbi,
          functionName: "castVoteForFork",
          args: [params.forkId as Hex, BigInt(params.proposalId), choiceUint],
          account: acc,
        });
      } else {
        txHash = await wallet.writeContract({
          address: contracts.votingPolicy as Hex,
          abi: votingPolicyAbi,
          functionName: "castVote",
          args: [BigInt(params.proposalId), choiceUint],
          account: acc,
        });
      }

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: votingPolicyAbi,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "VoteCast") {
            return {
              votingPower: Number(
                (decoded.args as { votingPower: bigint }).votingPower,
              ),
              transactionHash: txHash,
            };
          }
        } catch {
          // Not a matching event, skip
        }
      }

      throw new Error(
        `Transaction ${txHash} succeeded but VoteCast event not found in receipt logs`,
      );
    },

    async getVoteRecord(forkId: string, proposalId: number): Promise<GovernanceVoteRecord> {
      const forkHex = forkId as Hex;
      const pid = BigInt(proposalId);

      const [tally, result] = await Promise.all([
        voting.read.getVoteTally([forkHex, pid]),
        voting.read.proposalResult([forkHex, pid]),
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = tally as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = result as any;

      return {
        forVotes: Number(t.forVotes ?? t[0] ?? 0),
        againstVotes: Number(t.againstVotes ?? t[1] ?? 0),
        abstainVotes: Number(t.abstainVotes ?? t[2] ?? 0),
        quorumMet: r[0] ?? r.quorumMet ?? false,
        thresholdMet: r[1] ?? r.thresholdMet ?? false,
        approved: r[2] ?? r.approved ?? false,
      };
    },

    // --- Execution Policy ---

    async checkAuthorization(params: CheckAuthorizationParams): Promise<AuthorizationResult> {
      const pid = BigInt(params.proposalId);
      const scope = params.scope as Hex;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = (await execution.read.getProposalState([pid])) as any;

      if (!state.scopesDefined) {
        return { authorized: false, reason: "No execution scopes defined for this proposal" };
      }

      if (!state.approved) {
        return { authorized: false, reason: "Proposal not approved for execution" };
      }

      const allowed = await execution.read.isScopeAllowed([pid, scope]);
      if (!allowed) {
        return { authorized: false, reason: `Scope ${params.scope} is not allowed for this proposal` };
      }

      const consumed = await execution.read.isScopeConsumed([pid, scope]);
      if (consumed) {
        return { authorized: false, reason: `Scope ${params.scope} has already been consumed` };
      }

      return { authorized: true };
    },

    // --- Attestation ---

    async attest(params: AttestParams): Promise<AttestResult> {
      const { wallet, account: acc } = requireWallet();
      const kindUint = ATTESTATION_KIND_TO_UINT[params.kind];

      const txHash = await wallet.writeContract({
        address: contracts.attestationLog as Hex,
        abi: attestationLogAbi,
        functionName: "appendAttestation",
        args: [
          params.forkId as Hex,
          BigInt(params.proposalId),
          kindUint,
          params.evidenceHash as Hex,
        ],
        account: acc,
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: attestationLogAbi,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "AttestationAppended") {
            return {
              attestationId: Number(
                (decoded.args as { attestationId: bigint }).attestationId,
              ),
              transactionHash: txHash,
            };
          }
        } catch {
          // Not a matching event, skip
        }
      }

      throw new Error(
        `Transaction ${txHash} succeeded but AttestationAppended event not found in receipt logs`,
      );
    },

    async verifyAttestation(attestationId: number): Promise<GovernanceAttestation> {
      const raw = await attestationContract.read.getAttestation([BigInt(attestationId)]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return parseAttestation(attestationId, raw as any);
    },

    // --- Chain Info ---

    async getChainId(): Promise<number> {
      return publicClient.getChainId();
    },

    async getBlockNumber(): Promise<number> {
      const blockNumber = await publicClient.getBlockNumber();
      return Number(blockNumber);
    },
  };
}

export default { manifest, create } satisfies PluginModule<GovernanceChain>;

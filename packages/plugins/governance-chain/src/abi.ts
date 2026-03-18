/**
 * Contract ABIs for the four governance contracts on Base.
 * Derived from the Solidity sources in contracts/ (issue #465).
 */

export const governanceRegistryAbi = [
  // Read
  {
    type: "function",
    name: "getProposal",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [
      {
        name: "proposal",
        type: "tuple",
        components: [
          { name: "contentHash", type: "bytes32" },
          { name: "forkId", type: "bytes32" },
          { name: "proposer", type: "address" },
          { name: "createdAt", type: "uint64" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "proposalStatus",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "proposalForkId",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "proposalCountByFork",
    inputs: [{ name: "forkId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "proposalIdsByFork",
    inputs: [{ name: "forkId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nextProposalId",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "defaultForkId",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  // Write
  {
    type: "function",
    name: "createProposal",
    inputs: [{ name: "contentHash", type: "bytes32" }],
    outputs: [{ name: "proposalId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "createProposalForFork",
    inputs: [
      { name: "forkId", type: "bytes32" },
      { name: "contentHash", type: "bytes32" },
    ],
    outputs: [{ name: "proposalId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "updateProposalStatus",
    inputs: [
      { name: "proposalId", type: "uint256" },
      { name: "newStatus", type: "uint8" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // Events
  {
    type: "event",
    name: "ProposalCreated",
    inputs: [
      { name: "proposalId", type: "uint256", indexed: true },
      { name: "forkId", type: "bytes32", indexed: true },
      { name: "proposer", type: "address", indexed: true },
      { name: "contentHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ProposalStatusUpdated",
    inputs: [
      { name: "proposalId", type: "uint256", indexed: true },
      { name: "previousStatus", type: "uint8", indexed: false },
      { name: "newStatus", type: "uint8", indexed: false },
      { name: "updatedBy", type: "address", indexed: true },
    ],
  },
] as const;

export const votingPolicyAbi = [
  // Read
  {
    type: "function",
    name: "defaultForkId",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isMaintainer",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "maintainerCount",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "maintainers",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getForkPolicy",
    inputs: [{ name: "forkId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "quorumBps", type: "uint16" },
          { name: "threshold", type: "uint8" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getVoteTally",
    inputs: [
      { name: "forkId", type: "bytes32" },
      { name: "proposalId", type: "uint256" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "forVotes", type: "uint32" },
          { name: "againstVotes", type: "uint32" },
          { name: "abstainVotes", type: "uint32" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "hasMaintainerVoted",
    inputs: [
      { name: "forkId", type: "bytes32" },
      { name: "proposalId", type: "uint256" },
      { name: "maintainer", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "proposalResult",
    inputs: [
      { name: "forkId", type: "bytes32" },
      { name: "proposalId", type: "uint256" },
    ],
    outputs: [
      { name: "quorumMet", type: "bool" },
      { name: "thresholdMet", type: "bool" },
      { name: "approved", type: "bool" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isApproved",
    inputs: [
      { name: "forkId", type: "bytes32" },
      { name: "proposalId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  // Write
  {
    type: "function",
    name: "castVote",
    inputs: [
      { name: "proposalId", type: "uint256" },
      { name: "choice", type: "uint8" },
    ],
    outputs: [{ name: "votingPower", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "castVoteForFork",
    inputs: [
      { name: "forkId", type: "bytes32" },
      { name: "proposalId", type: "uint256" },
      { name: "choice", type: "uint8" },
    ],
    outputs: [{ name: "votingPower", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  // Events
  {
    type: "event",
    name: "VoteCast",
    inputs: [
      { name: "forkId", type: "bytes32", indexed: true },
      { name: "proposalId", type: "uint256", indexed: true },
      { name: "voter", type: "address", indexed: true },
      { name: "choice", type: "uint8", indexed: false },
      { name: "votingPower", type: "uint256", indexed: false },
    ],
  },
] as const;

export const executionPolicyAbi = [
  // Read
  {
    type: "function",
    name: "CONSENT_GATE_SCOPE",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getProposalState",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "forkId", type: "bytes32" },
          { name: "scopesDefined", type: "bool" },
          { name: "approved", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "proposalScopes",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [{ name: "", type: "bytes32[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isScopeAllowed",
    inputs: [
      { name: "proposalId", type: "uint256" },
      { name: "scope", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isScopeConsumed",
    inputs: [
      { name: "proposalId", type: "uint256" },
      { name: "scope", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  // Write
  {
    type: "function",
    name: "consumeScope",
    inputs: [
      { name: "proposalId", type: "uint256" },
      { name: "scope", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "approveProposalForExecution",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // Events
  {
    type: "event",
    name: "ProposalExecutionApproved",
    inputs: [
      { name: "proposalId", type: "uint256", indexed: true },
      { name: "forkId", type: "bytes32", indexed: true },
    ],
  },
  {
    type: "event",
    name: "ScopeConsumed",
    inputs: [
      { name: "proposalId", type: "uint256", indexed: true },
      { name: "scope", type: "bytes32", indexed: true },
      { name: "executor", type: "address", indexed: true },
    ],
  },
] as const;

export const attestationLogAbi = [
  // Read
  {
    type: "function",
    name: "getAttestation",
    inputs: [{ name: "attestationId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "forkId", type: "bytes32" },
          { name: "proposalId", type: "uint256" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "kind", type: "uint8" },
          { name: "attester", type: "address" },
          { name: "timestamp", type: "uint64" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "totalAttestations",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "attestationIdsByFork",
    inputs: [{ name: "forkId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "attestationIdsByProposal",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256[]" }],
    stateMutability: "view",
  },
  // Write
  {
    type: "function",
    name: "appendAttestation",
    inputs: [
      { name: "forkId", type: "bytes32" },
      { name: "proposalId", type: "uint256" },
      { name: "kind", type: "uint8" },
      { name: "evidenceHash", type: "bytes32" },
    ],
    outputs: [{ name: "attestationId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  // Events
  {
    type: "event",
    name: "AttestationAppended",
    inputs: [
      { name: "attestationId", type: "uint256", indexed: true },
      { name: "proposalId", type: "uint256", indexed: true },
      { name: "forkId", type: "bytes32", indexed: true },
      { name: "kind", type: "uint8", indexed: false },
      { name: "evidenceHash", type: "bytes32", indexed: false },
      { name: "attester", type: "address", indexed: false },
    ],
  },
] as const;

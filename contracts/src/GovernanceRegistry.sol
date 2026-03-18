// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title GovernanceRegistry
/// @notice Proposal metadata registry for AO governance on Base (chain ID 8453).
///         Each proposal is scoped to a fork ID and follows a status lifecycle.
contract GovernanceRegistry is Ownable {
    enum Status {
        Draft,
        Active,
        Approved,
        Rejected,
        Executed,
        Cancelled
    }

    struct Proposal {
        bytes32 contentHash;
        address proposer;
        uint256 timestamp;
        Status status;
        bytes32 forkId;
    }

    /// @notice Auto-incrementing proposal counter.
    uint256 public proposalCount;

    /// @notice proposalId => Proposal
    mapping(uint256 => Proposal) public proposals;

    /// @notice Addresses allowed to create proposals (in addition to the owner).
    mapping(address => bool) public proposers;

    event ProposalCreated(
        uint256 indexed proposalId,
        bytes32 indexed forkId,
        address indexed proposer,
        bytes32 contentHash
    );
    event StatusChanged(uint256 indexed proposalId, Status oldStatus, Status newStatus);
    event ProposerUpdated(address indexed account, bool allowed);

    error NotProposer();
    error InvalidProposalId();
    error InvalidTransition(Status from, Status to);
    error ZeroContentHash();

    modifier onlyProposer() {
        if (!proposers[msg.sender] && msg.sender != owner()) revert NotProposer();
        _;
    }

    modifier validProposal(uint256 proposalId) {
        if (proposalId == 0 || proposalId > proposalCount) revert InvalidProposalId();
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Grant or revoke proposer role.
    function setProposer(address account, bool allowed) external onlyOwner {
        proposers[account] = allowed;
        emit ProposerUpdated(account, allowed);
    }

    /// @notice Create a new proposal scoped to a fork.
    function createProposal(bytes32 contentHash, bytes32 forkId)
        external
        onlyProposer
        returns (uint256 proposalId)
    {
        if (contentHash == bytes32(0)) revert ZeroContentHash();

        proposalId = ++proposalCount;
        proposals[proposalId] = Proposal({
            contentHash: contentHash,
            proposer: msg.sender,
            timestamp: block.timestamp,
            status: Status.Draft,
            forkId: forkId
        });

        emit ProposalCreated(proposalId, forkId, msg.sender, contentHash);
    }

    /// @notice Advance proposal status. Only owner can transition status.
    function setStatus(uint256 proposalId, Status newStatus)
        external
        onlyOwner
        validProposal(proposalId)
    {
        Proposal storage p = proposals[proposalId];
        Status oldStatus = p.status;
        _validateTransition(oldStatus, newStatus);
        p.status = newStatus;
        emit StatusChanged(proposalId, oldStatus, newStatus);
    }

    /// @notice Read full proposal data.
    function getProposal(uint256 proposalId)
        external
        view
        validProposal(proposalId)
        returns (Proposal memory)
    {
        return proposals[proposalId];
    }

    /// @dev Enforce valid status transitions.
    function _validateTransition(Status from, Status to) internal pure {
        // Draft -> Active or Cancelled
        if (from == Status.Draft) {
            if (to != Status.Active && to != Status.Cancelled) {
                revert InvalidTransition(from, to);
            }
            return;
        }
        // Active -> Approved, Rejected, or Cancelled
        if (from == Status.Active) {
            if (to != Status.Approved && to != Status.Rejected && to != Status.Cancelled) {
                revert InvalidTransition(from, to);
            }
            return;
        }
        // Approved -> Executed or Cancelled
        if (from == Status.Approved) {
            if (to != Status.Executed && to != Status.Cancelled) {
                revert InvalidTransition(from, to);
            }
            return;
        }
        // All other transitions are invalid (Rejected, Executed, Cancelled are terminal)
        revert InvalidTransition(from, to);
    }
}

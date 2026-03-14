// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title GovernanceRegistry
/// @notice Stores governance proposal metadata with fork-scoped defaults.
contract GovernanceRegistry is Ownable {
    uint256 public constant TARGET_CHAIN_ID = 8453;

    enum ProposalStatus {
        Draft,
        Active,
        Approved,
        Rejected,
        Executed,
        Cancelled
    }

    struct Proposal {
        bytes32 contentHash;
        bytes32 forkId;
        address proposer;
        uint64 createdAt;
        ProposalStatus status;
    }

    error InvalidForkId();
    error InvalidContentHash();
    error ProposalNotFound(uint256 proposalId);
    error UnauthorizedStatusUpdate(address caller, uint256 proposalId);
    error InvalidStatusTransition(ProposalStatus from, ProposalStatus to);

    event ProposalCreated(
        uint256 indexed proposalId, bytes32 indexed forkId, address indexed proposer, bytes32 contentHash
    );
    event ProposalStatusUpdated(
        uint256 indexed proposalId, ProposalStatus previousStatus, ProposalStatus newStatus, address indexed updatedBy
    );
    event StatusManagerUpdated(address indexed manager, bool isAllowed);

    bytes32 public immutable defaultForkId;

    uint256 private _nextProposalId = 1;
    mapping(uint256 => Proposal) private _proposals;
    mapping(bytes32 => uint256[]) private _proposalIdsByFork;
    mapping(address => bool) public statusManagers;

    constructor(address initialOwner, bytes32 defaultForkId_) Ownable(initialOwner) {
        if (defaultForkId_ == bytes32(0)) revert InvalidForkId();
        defaultForkId = defaultForkId_;
    }

    function createProposal(bytes32 contentHash) external returns (uint256 proposalId) {
        return createProposalForFork(defaultForkId, contentHash);
    }

    function createProposalForFork(bytes32 forkId, bytes32 contentHash) public returns (uint256 proposalId) {
        if (forkId == bytes32(0)) revert InvalidForkId();
        if (contentHash == bytes32(0)) revert InvalidContentHash();

        proposalId = _nextProposalId++;
        _proposals[proposalId] = Proposal({
            contentHash: contentHash,
            forkId: forkId,
            proposer: msg.sender,
            createdAt: uint64(block.timestamp),
            status: ProposalStatus.Draft
        });
        _proposalIdsByFork[forkId].push(proposalId);

        emit ProposalCreated(proposalId, forkId, msg.sender, contentHash);
    }

    function setStatusManager(address manager, bool isAllowed) external onlyOwner {
        statusManagers[manager] = isAllowed;
        emit StatusManagerUpdated(manager, isAllowed);
    }

    function updateProposalStatus(uint256 proposalId, ProposalStatus newStatus) external {
        Proposal storage proposal = _proposalForUpdate(proposalId);
        ProposalStatus currentStatus = proposal.status;

        bool canManage = msg.sender == owner() || statusManagers[msg.sender];
        bool canSelfCancel = (msg.sender == proposal.proposer) && (newStatus == ProposalStatus.Cancelled)
            && (currentStatus == ProposalStatus.Draft || currentStatus == ProposalStatus.Active);
        if (!canManage && !canSelfCancel) revert UnauthorizedStatusUpdate(msg.sender, proposalId);
        if (!_canTransition(currentStatus, newStatus)) {
            revert InvalidStatusTransition(currentStatus, newStatus);
        }

        proposal.status = newStatus;
        emit ProposalStatusUpdated(proposalId, currentStatus, newStatus, msg.sender);
    }

    function getProposal(uint256 proposalId) external view returns (Proposal memory proposal) {
        proposal = _proposals[proposalId];
        if (proposal.proposer == address(0)) revert ProposalNotFound(proposalId);
    }

    function proposalStatus(uint256 proposalId) external view returns (ProposalStatus) {
        Proposal memory proposal = _proposals[proposalId];
        if (proposal.proposer == address(0)) revert ProposalNotFound(proposalId);
        return proposal.status;
    }

    function proposalForkId(uint256 proposalId) external view returns (bytes32) {
        Proposal memory proposal = _proposals[proposalId];
        if (proposal.proposer == address(0)) revert ProposalNotFound(proposalId);
        return proposal.forkId;
    }

    function proposalCountByFork(bytes32 forkId) external view returns (uint256) {
        return _proposalIdsByFork[forkId].length;
    }

    function proposalIdsByFork(bytes32 forkId) external view returns (uint256[] memory) {
        return _proposalIdsByFork[forkId];
    }

    function nextProposalId() external view returns (uint256) {
        return _nextProposalId;
    }

    function _proposalForUpdate(uint256 proposalId) private view returns (Proposal storage proposal) {
        proposal = _proposals[proposalId];
        if (proposal.proposer == address(0)) revert ProposalNotFound(proposalId);
    }

    function _canTransition(ProposalStatus from, ProposalStatus to) private pure returns (bool) {
        if (from == ProposalStatus.Draft) {
            return to == ProposalStatus.Active || to == ProposalStatus.Cancelled;
        }
        if (from == ProposalStatus.Active) {
            return to == ProposalStatus.Approved || to == ProposalStatus.Rejected || to == ProposalStatus.Cancelled;
        }
        if (from == ProposalStatus.Approved) {
            return to == ProposalStatus.Executed || to == ProposalStatus.Cancelled;
        }
        return false;
    }
}

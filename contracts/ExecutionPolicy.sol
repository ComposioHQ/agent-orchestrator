// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IGovernanceRegistry {
    enum ProposalStatus {
        Draft,
        Active,
        Approved,
        Rejected,
        Executed,
        Cancelled
    }

    function proposalStatus(uint256 proposalId) external view returns (ProposalStatus);
    function proposalForkId(uint256 proposalId) external view returns (bytes32);
}

interface IVotingPolicy {
    enum ThresholdType {
        Majority,
        Supermajority,
        Unanimous
    }

    function isApproved(bytes32 forkId, uint256 proposalId) external view returns (bool);
    function isApprovedWithThreshold(bytes32 forkId, uint256 proposalId, ThresholdType threshold)
        external
        view
        returns (bool);
}

/// @title ExecutionPolicy
/// @notice Binds approved proposals to explicit mutation scopes and enforces consumption boundaries.
contract ExecutionPolicy is Ownable {
    bytes32 public constant CONSENT_GATE_SCOPE = keccak256("CONSENT_GATE_CHANGE");

    struct ProposalExecutionState {
        bytes32 forkId;
        bool scopesDefined;
        bool approved;
    }

    error InvalidForkId();
    error InvalidProposal(uint256 proposalId);
    error InvalidScope(bytes32 scope);
    error DuplicateScope(bytes32 scope);
    error ScopesAlreadyDefined(uint256 proposalId);
    error ProposalAlreadyExecutionApproved(uint256 proposalId);
    error ProposalNotApprovedInRegistry(uint256 proposalId);
    error ProposalNotApprovedByVoting(uint256 proposalId);
    error ForkMismatch(uint256 proposalId, bytes32 expectedForkId, bytes32 actualForkId);
    error MissingSupermajorityForConsentGate(uint256 proposalId);
    error ProposalNotExecutionApproved(uint256 proposalId);
    error ScopeNotAllowed(uint256 proposalId, bytes32 scope);
    error ScopeAlreadyConsumed(uint256 proposalId, bytes32 scope);
    error UnauthorizedExecutor(address caller);
    error ProposalNoLongerApproved(uint256 proposalId);

    event MutationExecutorUpdated(address indexed executor);
    event ProposalScopesDefined(uint256 indexed proposalId, bytes32 indexed forkId, bytes32[] scopes);
    event ProposalExecutionApproved(uint256 indexed proposalId, bytes32 indexed forkId);
    event ScopeConsumed(uint256 indexed proposalId, bytes32 indexed scope, address indexed executor);

    IGovernanceRegistry public immutable governanceRegistry;
    IVotingPolicy public immutable votingPolicy;
    address public mutationExecutor;

    mapping(uint256 => ProposalExecutionState) private _proposalState;
    mapping(uint256 => mapping(bytes32 => bool)) private _allowedScope;
    mapping(uint256 => mapping(bytes32 => bool)) private _consumedScope;
    mapping(uint256 => bytes32[]) private _proposalScopes;

    constructor(address initialOwner, address governanceRegistry_, address votingPolicy_, address mutationExecutor_)
        Ownable(initialOwner)
    {
        governanceRegistry = IGovernanceRegistry(governanceRegistry_);
        votingPolicy = IVotingPolicy(votingPolicy_);
        mutationExecutor = mutationExecutor_;
    }

    function setMutationExecutor(address executor) external onlyOwner {
        mutationExecutor = executor;
        emit MutationExecutorUpdated(executor);
    }

    function defineProposalScopes(uint256 proposalId, bytes32 forkId, bytes32[] calldata scopes) external onlyOwner {
        if (proposalId == 0) revert InvalidProposal(proposalId);
        if (forkId == bytes32(0)) revert InvalidForkId();
        if (scopes.length == 0) revert InvalidScope(bytes32(0));

        ProposalExecutionState storage state = _proposalState[proposalId];
        if (state.scopesDefined) revert ScopesAlreadyDefined(proposalId);

        state.forkId = forkId;
        state.scopesDefined = true;

        uint256 len = scopes.length;
        for (uint256 i = 0; i < len; ++i) {
            bytes32 scope = scopes[i];
            if (scope == bytes32(0)) revert InvalidScope(scope);
            if (_allowedScope[proposalId][scope]) revert DuplicateScope(scope);
            _allowedScope[proposalId][scope] = true;
            _proposalScopes[proposalId].push(scope);
        }

        emit ProposalScopesDefined(proposalId, forkId, scopes);
    }

    function approveProposalForExecution(uint256 proposalId) external {
        ProposalExecutionState storage state = _proposalState[proposalId];
        if (!state.scopesDefined) revert InvalidProposal(proposalId);
        if (state.approved) revert ProposalAlreadyExecutionApproved(proposalId);

        bytes32 registryForkId = governanceRegistry.proposalForkId(proposalId);
        if (registryForkId != state.forkId) {
            revert ForkMismatch(proposalId, state.forkId, registryForkId);
        }

        IGovernanceRegistry.ProposalStatus status = governanceRegistry.proposalStatus(proposalId);
        if (status != IGovernanceRegistry.ProposalStatus.Approved) {
            revert ProposalNotApprovedInRegistry(proposalId);
        }
        if (!votingPolicy.isApproved(state.forkId, proposalId)) {
            revert ProposalNotApprovedByVoting(proposalId);
        }

        if (_allowedScope[proposalId][CONSENT_GATE_SCOPE]) {
            bool hasSupermajority = votingPolicy.isApprovedWithThreshold(
                state.forkId, proposalId, IVotingPolicy.ThresholdType.Supermajority
            );
            if (!hasSupermajority) {
                revert MissingSupermajorityForConsentGate(proposalId);
            }
        }

        state.approved = true;
        emit ProposalExecutionApproved(proposalId, state.forkId);
    }

    function consumeScope(uint256 proposalId, bytes32 scope) external {
        if (msg.sender != mutationExecutor && msg.sender != owner()) {
            revert UnauthorizedExecutor(msg.sender);
        }

        ProposalExecutionState memory state = _proposalState[proposalId];
        if (!state.approved) revert ProposalNotExecutionApproved(proposalId);

        // Live-check registry status — a proposal can be cancelled after execution approval
        IGovernanceRegistry.ProposalStatus liveStatus = governanceRegistry.proposalStatus(proposalId);
        if (liveStatus != IGovernanceRegistry.ProposalStatus.Approved && liveStatus != IGovernanceRegistry.ProposalStatus.Executed) {
            revert ProposalNoLongerApproved(proposalId);
        }

        if (!_allowedScope[proposalId][scope]) revert ScopeNotAllowed(proposalId, scope);
        if (_consumedScope[proposalId][scope]) revert ScopeAlreadyConsumed(proposalId, scope);

        _consumedScope[proposalId][scope] = true;
        emit ScopeConsumed(proposalId, scope, msg.sender);
    }

    function getProposalState(uint256 proposalId) external view returns (ProposalExecutionState memory) {
        return _proposalState[proposalId];
    }

    function proposalScopes(uint256 proposalId) external view returns (bytes32[] memory) {
        return _proposalScopes[proposalId];
    }

    function isScopeAllowed(uint256 proposalId, bytes32 scope) external view returns (bool) {
        return _allowedScope[proposalId][scope];
    }

    function isScopeConsumed(uint256 proposalId, bytes32 scope) external view returns (bool) {
        return _consumedScope[proposalId][scope];
    }
}

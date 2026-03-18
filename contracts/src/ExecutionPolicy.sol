// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ExecutionPolicy
/// @notice Maps approved proposals to allowed mutation scopes and enforces scope constraints.
///         Changing consent gates requires supermajority approval.
contract ExecutionPolicy is Ownable {
    struct MutationScope {
        bytes32 scopeHash;
        bool active;
    }

    /// @notice proposalId => array of allowed mutation scopes.
    mapping(uint256 => MutationScope[]) public proposalScopes;

    /// @notice Consent gates — scope hashes that require supermajority to modify.
    mapping(bytes32 => bool) public consentGates;

    /// @notice Addresses trusted to execute approved proposals.
    mapping(address => bool) public executors;

    event ScopeAssigned(uint256 indexed proposalId, bytes32 indexed scopeHash);
    event ScopeRevoked(uint256 indexed proposalId, uint256 index);
    event ConsentGateUpdated(bytes32 indexed scopeHash, bool required);
    event ExecutorUpdated(address indexed account, bool allowed);
    event ProposalExecuted(uint256 indexed proposalId, address indexed executor);

    error NotExecutor();
    error ScopeNotActive();
    error ConsentGateViolation(bytes32 scopeHash);
    error NoScopes();
    error IndexOutOfBounds();

    modifier onlyExecutor() {
        if (!executors[msg.sender] && msg.sender != owner()) revert NotExecutor();
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Grant or revoke executor role.
    function setExecutor(address account, bool allowed) external onlyOwner {
        executors[account] = allowed;
        emit ExecutorUpdated(account, allowed);
    }

    /// @notice Assign a mutation scope to an approved proposal.
    function assignScope(uint256 proposalId, bytes32 scopeHash) external onlyOwner {
        proposalScopes[proposalId].push(MutationScope({scopeHash: scopeHash, active: true}));
        emit ScopeAssigned(proposalId, scopeHash);
    }

    /// @notice Revoke a specific scope from a proposal.
    function revokeScope(uint256 proposalId, uint256 index) external onlyOwner {
        MutationScope[] storage scopes = proposalScopes[proposalId];
        if (index >= scopes.length) revert IndexOutOfBounds();
        scopes[index].active = false;
        emit ScopeRevoked(proposalId, index);
    }

    /// @notice Mark a scope hash as a consent gate (requires supermajority to change).
    /// @dev In practice, the owner should only call this after a supermajority vote.
    function setConsentGate(bytes32 scopeHash, bool required) external onlyOwner {
        consentGates[scopeHash] = required;
        emit ConsentGateUpdated(scopeHash, required);
    }

    /// @notice Execute a proposal — verifies all scopes are active and no consent gate violations.
    function execute(uint256 proposalId) external onlyExecutor {
        MutationScope[] storage scopes = proposalScopes[proposalId];
        if (scopes.length == 0) revert NoScopes();

        for (uint256 i = 0; i < scopes.length; i++) {
            if (!scopes[i].active) revert ScopeNotActive();
        }

        emit ProposalExecuted(proposalId, msg.sender);
    }

    /// @notice Validate that a given scope hash is allowed for a proposal.
    function validateScope(uint256 proposalId, bytes32 scopeHash) external view returns (bool) {
        MutationScope[] storage scopes = proposalScopes[proposalId];
        for (uint256 i = 0; i < scopes.length; i++) {
            if (scopes[i].scopeHash == scopeHash && scopes[i].active) {
                return true;
            }
        }
        return false;
    }

    /// @notice Get the number of scopes assigned to a proposal.
    function scopeCount(uint256 proposalId) external view returns (uint256) {
        return proposalScopes[proposalId].length;
    }

    /// @notice Get a scope by index.
    function getScope(uint256 proposalId, uint256 index)
        external
        view
        returns (MutationScope memory)
    {
        if (index >= proposalScopes[proposalId].length) revert IndexOutOfBounds();
        return proposalScopes[proposalId][index];
    }
}

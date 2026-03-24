// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title AttestationLog
/// @notice Append-only evidence hash log for CI, review, and convergence attestations.
contract AttestationLog is Ownable {
    enum AttestationKind {
        CI,
        ReviewVerdict,
        ConvergencePattern,
        Custom
    }

    struct Attestation {
        bytes32 forkId;
        uint256 proposalId;
        bytes32 evidenceHash;
        AttestationKind kind;
        address attester;
        uint64 timestamp;
    }

    error InvalidForkId();
    error InvalidEvidenceHash();
    error UnauthorizedAttester(address caller);

    event AttesterUpdated(address indexed attester, bool isAllowed);
    event AttestationAppended(
        uint256 indexed attestationId,
        uint256 indexed proposalId,
        bytes32 indexed forkId,
        AttestationKind kind,
        bytes32 evidenceHash,
        address attester
    );

    mapping(address => bool) public attesters;
    Attestation[] private _attestations;
    mapping(bytes32 => uint256[]) private _attestationIdsByFork;
    mapping(uint256 => uint256[]) private _attestationIdsByProposal;

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setAttester(address attester, bool isAllowed) external onlyOwner {
        attesters[attester] = isAllowed;
        emit AttesterUpdated(attester, isAllowed);
    }

    function appendAttestation(bytes32 forkId, uint256 proposalId, AttestationKind kind, bytes32 evidenceHash)
        external
        returns (uint256 attestationId)
    {
        if (forkId == bytes32(0)) revert InvalidForkId();
        if (evidenceHash == bytes32(0)) revert InvalidEvidenceHash();
        if (msg.sender != owner() && !attesters[msg.sender]) {
            revert UnauthorizedAttester(msg.sender);
        }

        attestationId = _attestations.length;
        _attestations.push(
            Attestation({
                forkId: forkId,
                proposalId: proposalId,
                evidenceHash: evidenceHash,
                kind: kind,
                attester: msg.sender,
                timestamp: uint64(block.timestamp)
            })
        );
        _attestationIdsByFork[forkId].push(attestationId);
        _attestationIdsByProposal[proposalId].push(attestationId);

        emit AttestationAppended(attestationId, proposalId, forkId, kind, evidenceHash, msg.sender);
    }

    function getAttestation(uint256 attestationId) external view returns (Attestation memory) {
        return _attestations[attestationId];
    }

    function totalAttestations() external view returns (uint256) {
        return _attestations.length;
    }

    function attestationIdsByFork(bytes32 forkId) external view returns (uint256[] memory) {
        return _attestationIdsByFork[forkId];
    }

    function attestationIdsByProposal(uint256 proposalId) external view returns (uint256[] memory) {
        return _attestationIdsByProposal[proposalId];
    }
}

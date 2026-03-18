// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title AttestationLog
/// @notice Append-only log of evidence hashes (CI results, review verdicts,
///         convergence patterns) linked to proposals.
contract AttestationLog is Ownable {
    enum AttestationType {
        CI,
        Review,
        Convergence,
        Other
    }

    struct Attestation {
        bytes32 evidenceHash;
        address attester;
        uint256 timestamp;
        uint256 proposalId;
        AttestationType attestationType;
    }

    /// @notice All attestations in append-only order.
    Attestation[] public attestations;

    /// @notice proposalId => attestation indices for that proposal.
    mapping(uint256 => uint256[]) public proposalAttestations;

    /// @notice Addresses allowed to submit attestations.
    mapping(address => bool) public attesters;

    event AttestationAdded(
        uint256 indexed attestationId,
        uint256 indexed proposalId,
        address indexed attester,
        bytes32 evidenceHash,
        AttestationType attestationType
    );
    event AttesterUpdated(address indexed account, bool allowed);

    error NotAttester();
    error ZeroEvidenceHash();

    modifier onlyAttester() {
        if (!attesters[msg.sender] && msg.sender != owner()) revert NotAttester();
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Grant or revoke attester role.
    function setAttester(address account, bool allowed) external onlyOwner {
        attesters[account] = allowed;
        emit AttesterUpdated(account, allowed);
    }

    /// @notice Submit an attestation for a proposal.
    function attest(uint256 proposalId, bytes32 evidenceHash, AttestationType attestationType)
        external
        onlyAttester
        returns (uint256 attestationId)
    {
        if (evidenceHash == bytes32(0)) revert ZeroEvidenceHash();

        attestationId = attestations.length;
        attestations.push(
            Attestation({
                evidenceHash: evidenceHash,
                attester: msg.sender,
                timestamp: block.timestamp,
                proposalId: proposalId,
                attestationType: attestationType
            })
        );
        proposalAttestations[proposalId].push(attestationId);

        emit AttestationAdded(attestationId, proposalId, msg.sender, evidenceHash, attestationType);
    }

    /// @notice Total number of attestations.
    function attestationCount() external view returns (uint256) {
        return attestations.length;
    }

    /// @notice Get attestation IDs for a proposal.
    function getProposalAttestations(uint256 proposalId)
        external
        view
        returns (uint256[] memory)
    {
        return proposalAttestations[proposalId];
    }

    /// @notice Get a specific attestation by ID.
    function getAttestation(uint256 attestationId) external view returns (Attestation memory) {
        return attestations[attestationId];
    }
}

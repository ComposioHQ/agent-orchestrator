// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AttestationLog} from "../AttestationLog.sol";
import {TestBase} from "./utils/TestBase.sol";

contract AttestationLogTest is TestBase {
    bytes32 private constant FORK_ID = keccak256("fork/default");
    uint256 private constant PROPOSAL_ID = 42;
    bytes32 private constant EVIDENCE_HASH = keccak256("ci-passing-sha");

    address private owner = address(0xA11CE);
    address private attester = address(0xBEEF);
    address private outsider = address(0xDEAD);

    AttestationLog private log;

    function setUp() public {
        log = new AttestationLog(owner);
    }

    function testOwnerCanAppendAttestation() public {
        vm.prank(owner);
        uint256 attestationId =
            log.appendAttestation(FORK_ID, PROPOSAL_ID, AttestationLog.AttestationKind.CI, EVIDENCE_HASH);

        assertEq(attestationId, 0, "first attestation id should be zero");
        AttestationLog.Attestation memory attestation = log.getAttestation(attestationId);
        assertEq(attestation.forkId, FORK_ID, "fork id should match");
        assertEq(attestation.proposalId, PROPOSAL_ID, "proposal id should match");
        assertEq(attestation.evidenceHash, EVIDENCE_HASH, "evidence hash should match");
        assertEq(attestation.attester, owner, "owner should be recorded as attester");
    }

    function testAuthorizedAttesterCanAppend() public {
        vm.prank(owner);
        log.setAttester(attester, true);

        vm.prank(attester);
        log.appendAttestation(FORK_ID, PROPOSAL_ID, AttestationLog.AttestationKind.ReviewVerdict, EVIDENCE_HASH);

        assertEq(log.totalAttestations(), 1, "attestation should be appended");
    }

    function testUnauthorizedAttesterReverts() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(AttestationLog.UnauthorizedAttester.selector, outsider));
        log.appendAttestation(FORK_ID, PROPOSAL_ID, AttestationLog.AttestationKind.CI, EVIDENCE_HASH);
    }

    function testAppendRejectsInvalidForkOrEvidenceHash() public {
        vm.prank(owner);
        vm.expectRevert(AttestationLog.InvalidForkId.selector);
        log.appendAttestation(bytes32(0), PROPOSAL_ID, AttestationLog.AttestationKind.CI, EVIDENCE_HASH);

        vm.prank(owner);
        vm.expectRevert(AttestationLog.InvalidEvidenceHash.selector);
        log.appendAttestation(FORK_ID, PROPOSAL_ID, AttestationLog.AttestationKind.CI, bytes32(0));
    }

    function testAttestationIndexesByForkAndProposal() public {
        vm.prank(owner);
        log.appendAttestation(FORK_ID, PROPOSAL_ID, AttestationLog.AttestationKind.CI, keccak256("ci"));
        vm.prank(owner);
        log.appendAttestation(FORK_ID, PROPOSAL_ID, AttestationLog.AttestationKind.ConvergencePattern, keccak256("cv"));

        uint256[] memory byFork = log.attestationIdsByFork(FORK_ID);
        uint256[] memory byProposal = log.attestationIdsByProposal(PROPOSAL_ID);
        assertEq(byFork.length, 2, "fork index should include both attestations");
        assertEq(byProposal.length, 2, "proposal index should include both attestations");
    }
}

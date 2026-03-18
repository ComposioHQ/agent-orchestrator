// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AttestationLog} from "../src/AttestationLog.sol";

contract AttestationLogTest is Test {
    event AttesterUpdated(address indexed account, bool allowed);

    AttestationLog attestLog;
    address owner = address(this);
    address attester = address(0x1);
    bytes32 evidence1 = keccak256("ci-pass-abc123");
    bytes32 evidence2 = keccak256("review-approved");

    function setUp() public {
        attestLog = new AttestationLog(owner);
        attestLog.setAttester(attester, true);
    }

    function test_Attest() public {
        vm.prank(attester);
        uint256 id = attestLog.attest(1, evidence1, AttestationLog.AttestationType.CI);

        assertEq(id, 0);
        assertEq(attestLog.attestationCount(), 1);

        AttestationLog.Attestation memory a = attestLog.getAttestation(0);
        assertEq(a.evidenceHash, evidence1);
        assertEq(a.attester, attester);
        assertEq(a.proposalId, 1);
        assertEq(uint256(a.attestationType), uint256(AttestationLog.AttestationType.CI));
    }

    function test_OwnerCanAttest() public {
        uint256 id = attestLog.attest(1, evidence1, AttestationLog.AttestationType.Review);
        assertEq(id, 0);
    }

    function test_MultipleAttestations() public {
        vm.startPrank(attester);
        attestLog.attest(1, evidence1, AttestationLog.AttestationType.CI);
        attestLog.attest(1, evidence2, AttestationLog.AttestationType.Review);
        attestLog.attest(2, keccak256("convergence-data"), AttestationLog.AttestationType.Convergence);
        vm.stopPrank();

        assertEq(attestLog.attestationCount(), 3);

        uint256[] memory p1 = attestLog.getProposalAttestations(1);
        assertEq(p1.length, 2);
        assertEq(p1[0], 0);
        assertEq(p1[1], 1);

        uint256[] memory p2 = attestLog.getProposalAttestations(2);
        assertEq(p2.length, 1);
        assertEq(p2[0], 2);
    }

    function test_RevertNonAttester() public {
        vm.prank(address(0x99));
        vm.expectRevert(AttestationLog.NotAttester.selector);
        attestLog.attest(1, evidence1, AttestationLog.AttestationType.CI);
    }

    function test_RevertZeroEvidenceHash() public {
        vm.prank(attester);
        vm.expectRevert(AttestationLog.ZeroEvidenceHash.selector);
        attestLog.attest(1, bytes32(0), AttestationLog.AttestationType.CI);
    }

    function test_AppendOnly() public {
        vm.startPrank(attester);
        attestLog.attest(1, evidence1, AttestationLog.AttestationType.CI);
        attestLog.attest(1, evidence2, AttestationLog.AttestationType.Review);
        vm.stopPrank();

        // Verify both attestations exist and are in order
        AttestationLog.Attestation memory a0 = attestLog.getAttestation(0);
        AttestationLog.Attestation memory a1 = attestLog.getAttestation(1);

        assertEq(a0.evidenceHash, evidence1);
        assertEq(a1.evidenceHash, evidence2);
        assertTrue(a1.timestamp >= a0.timestamp);
    }

    function test_SetAttesterEmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit AttesterUpdated(address(0x5), true);
        attestLog.setAttester(address(0x5), true);
    }

    function test_AttestationTypes() public {
        vm.startPrank(attester);
        attestLog.attest(1, keccak256("a"), AttestationLog.AttestationType.CI);
        attestLog.attest(1, keccak256("b"), AttestationLog.AttestationType.Review);
        attestLog.attest(1, keccak256("c"), AttestationLog.AttestationType.Convergence);
        attestLog.attest(1, keccak256("d"), AttestationLog.AttestationType.Other);
        vm.stopPrank();

        assertEq(
            uint256(attestLog.getAttestation(0).attestationType),
            uint256(AttestationLog.AttestationType.CI)
        );
        assertEq(
            uint256(attestLog.getAttestation(1).attestationType),
            uint256(AttestationLog.AttestationType.Review)
        );
        assertEq(
            uint256(attestLog.getAttestation(2).attestationType),
            uint256(AttestationLog.AttestationType.Convergence)
        );
        assertEq(
            uint256(attestLog.getAttestation(3).attestationType),
            uint256(AttestationLog.AttestationType.Other)
        );
    }
}

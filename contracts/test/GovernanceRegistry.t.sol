// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {GovernanceRegistry} from "../src/GovernanceRegistry.sol";

contract GovernanceRegistryTest is Test {
    event ProposerUpdated(address indexed account, bool allowed);

    GovernanceRegistry registry;
    address owner = address(this);
    address proposer = address(0x1);
    address nonProposer = address(0x2);
    bytes32 forkId = keccak256("fork-main");
    bytes32 contentHash = keccak256("proposal-content");

    function setUp() public {
        registry = new GovernanceRegistry(owner);
        registry.setProposer(proposer, true);
    }

    function test_CreateProposal() public {
        vm.prank(proposer);
        uint256 id = registry.createProposal(contentHash, forkId);
        assertEq(id, 1);
        assertEq(registry.proposalCount(), 1);

        GovernanceRegistry.Proposal memory p = registry.getProposal(id);
        assertEq(p.contentHash, contentHash);
        assertEq(p.proposer, proposer);
        assertEq(p.forkId, forkId);
        assertEq(uint256(p.status), uint256(GovernanceRegistry.Status.Draft));
    }

    function test_OwnerCanCreateProposal() public {
        uint256 id = registry.createProposal(contentHash, forkId);
        assertEq(id, 1);
    }

    function test_RevertNonProposer() public {
        vm.prank(nonProposer);
        vm.expectRevert(GovernanceRegistry.NotProposer.selector);
        registry.createProposal(contentHash, forkId);
    }

    function test_RevertZeroContentHash() public {
        vm.prank(proposer);
        vm.expectRevert(GovernanceRegistry.ZeroContentHash.selector);
        registry.createProposal(bytes32(0), forkId);
    }

    function test_StatusLifecycleFull() public {
        vm.prank(proposer);
        uint256 id = registry.createProposal(contentHash, forkId);

        // Draft -> Active
        registry.setStatus(id, GovernanceRegistry.Status.Active);
        assertEq(uint256(registry.getProposal(id).status), uint256(GovernanceRegistry.Status.Active));

        // Active -> Approved
        registry.setStatus(id, GovernanceRegistry.Status.Approved);
        assertEq(
            uint256(registry.getProposal(id).status), uint256(GovernanceRegistry.Status.Approved)
        );

        // Approved -> Executed
        registry.setStatus(id, GovernanceRegistry.Status.Executed);
        assertEq(
            uint256(registry.getProposal(id).status), uint256(GovernanceRegistry.Status.Executed)
        );
    }

    function test_StatusDraftToCancelled() public {
        vm.prank(proposer);
        uint256 id = registry.createProposal(contentHash, forkId);
        registry.setStatus(id, GovernanceRegistry.Status.Cancelled);
        assertEq(
            uint256(registry.getProposal(id).status), uint256(GovernanceRegistry.Status.Cancelled)
        );
    }

    function test_RevertInvalidTransition() public {
        vm.prank(proposer);
        uint256 id = registry.createProposal(contentHash, forkId);

        // Draft -> Executed is invalid
        vm.expectRevert(
            abi.encodeWithSelector(
                GovernanceRegistry.InvalidTransition.selector,
                GovernanceRegistry.Status.Draft,
                GovernanceRegistry.Status.Executed
            )
        );
        registry.setStatus(id, GovernanceRegistry.Status.Executed);
    }

    function test_RevertTransitionFromTerminal() public {
        vm.prank(proposer);
        uint256 id = registry.createProposal(contentHash, forkId);
        registry.setStatus(id, GovernanceRegistry.Status.Active);
        registry.setStatus(id, GovernanceRegistry.Status.Rejected);

        // Rejected is terminal
        vm.expectRevert(
            abi.encodeWithSelector(
                GovernanceRegistry.InvalidTransition.selector,
                GovernanceRegistry.Status.Rejected,
                GovernanceRegistry.Status.Active
            )
        );
        registry.setStatus(id, GovernanceRegistry.Status.Active);
    }

    function test_RevertInvalidProposalId() public {
        vm.expectRevert(GovernanceRegistry.InvalidProposalId.selector);
        registry.setStatus(0, GovernanceRegistry.Status.Active);

        vm.expectRevert(GovernanceRegistry.InvalidProposalId.selector);
        registry.setStatus(999, GovernanceRegistry.Status.Active);
    }

    function test_SetProposerEmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit ProposerUpdated(address(0x5), true);
        registry.setProposer(address(0x5), true);
    }

    function test_MultipleProposals() public {
        vm.startPrank(proposer);
        uint256 id1 = registry.createProposal(keccak256("p1"), forkId);
        uint256 id2 = registry.createProposal(keccak256("p2"), forkId);
        vm.stopPrank();

        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(registry.proposalCount(), 2);
    }
}

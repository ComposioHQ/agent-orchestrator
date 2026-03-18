// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {GovernanceRegistry} from "../GovernanceRegistry.sol";
import {TestBase} from "./utils/TestBase.sol";

contract GovernanceRegistryTest is TestBase {
    bytes32 private constant DEFAULT_FORK = keccak256("fork/default");
    bytes32 private constant ALT_FORK = keccak256("fork/alt");
    bytes32 private constant CONTENT_HASH = keccak256("proposal-content");

    address private owner = address(0xA11CE);
    address private proposer = address(0xBEEF);
    address private manager = address(0xCAFE);
    address private outsider = address(0xD00D);

    GovernanceRegistry private registry;

    function setUp() public {
        registry = new GovernanceRegistry(owner, DEFAULT_FORK);
    }

    function testCreateProposalUsesDefaultFork() public {
        vm.prank(proposer);
        uint256 proposalId = registry.createProposal(CONTENT_HASH);

        GovernanceRegistry.Proposal memory proposal = registry.getProposal(proposalId);
        assertEq(proposal.forkId, DEFAULT_FORK, "default fork should be assigned");
        assertEq(proposal.proposer, proposer, "proposer should be stored");
        assertEq(
            uint256(proposal.status), uint256(GovernanceRegistry.ProposalStatus.Draft), "status should start at draft"
        );
        assertEq(registry.proposalCountByFork(DEFAULT_FORK), 1, "fork proposal count should increment");
    }

    function testCreateProposalForForkOverridesDefault() public {
        vm.prank(proposer);
        uint256 proposalId = registry.createProposalForFork(ALT_FORK, CONTENT_HASH);

        GovernanceRegistry.Proposal memory proposal = registry.getProposal(proposalId);
        assertEq(proposal.forkId, ALT_FORK, "explicit fork should be stored");
    }

    function testCreateProposalRevertsForZeroHash() public {
        vm.prank(proposer);
        vm.expectRevert(GovernanceRegistry.InvalidContentHash.selector);
        registry.createProposal(bytes32(0));
    }

    function testOwnerCanAssignStatusManagerAndManagerCanTransition() public {
        vm.prank(owner);
        registry.setStatusManager(manager, true);

        vm.prank(proposer);
        uint256 proposalId = registry.createProposal(CONTENT_HASH);

        vm.prank(manager);
        registry.updateProposalStatus(proposalId, GovernanceRegistry.ProposalStatus.Active);
        vm.prank(manager);
        registry.updateProposalStatus(proposalId, GovernanceRegistry.ProposalStatus.Approved);

        assertEq(
            uint256(registry.proposalStatus(proposalId)),
            uint256(GovernanceRegistry.ProposalStatus.Approved),
            "manager should advance status"
        );
    }

    function testProposerCanCancelDraftOrActiveOnly() public {
        vm.prank(proposer);
        uint256 proposalId = registry.createProposal(CONTENT_HASH);

        vm.prank(proposer);
        registry.updateProposalStatus(proposalId, GovernanceRegistry.ProposalStatus.Cancelled);
        assertEq(
            uint256(registry.proposalStatus(proposalId)),
            uint256(GovernanceRegistry.ProposalStatus.Cancelled),
            "proposer can cancel draft"
        );

        vm.prank(proposer);
        uint256 secondProposalId = registry.createProposal(CONTENT_HASH);

        vm.prank(owner);
        registry.updateProposalStatus(secondProposalId, GovernanceRegistry.ProposalStatus.Active);
        vm.prank(proposer);
        registry.updateProposalStatus(secondProposalId, GovernanceRegistry.ProposalStatus.Cancelled);
        assertEq(
            uint256(registry.proposalStatus(secondProposalId)),
            uint256(GovernanceRegistry.ProposalStatus.Cancelled),
            "proposer can cancel active"
        );
    }

    function testUnauthorizedActorCannotUpdateStatus() public {
        vm.prank(proposer);
        uint256 proposalId = registry.createProposal(CONTENT_HASH);

        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(GovernanceRegistry.UnauthorizedStatusUpdate.selector, outsider, proposalId)
        );
        registry.updateProposalStatus(proposalId, GovernanceRegistry.ProposalStatus.Active);
    }

    function testInvalidTransitionReverts() public {
        vm.prank(proposer);
        uint256 proposalId = registry.createProposal(CONTENT_HASH);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                GovernanceRegistry.InvalidStatusTransition.selector,
                GovernanceRegistry.ProposalStatus.Draft,
                GovernanceRegistry.ProposalStatus.Executed
            )
        );
        registry.updateProposalStatus(proposalId, GovernanceRegistry.ProposalStatus.Executed);
    }
}

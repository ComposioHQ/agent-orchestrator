// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VotingPolicy} from "../src/VotingPolicy.sol";

contract VotingPolicyTest is Test {
    VotingPolicy voting;
    address owner = address(this);
    address alice = address(0x1);
    address bob = address(0x2);
    address charlie = address(0x3);
    bytes32 forkId = keccak256("fork-main");

    function setUp() public {
        voting = new VotingPolicy(owner);
        voting.setMaintainer(alice, true);
        voting.setMaintainer(bob, true);
        voting.setMaintainer(charlie, true);
        voting.configureFork(forkId, 2, VotingPolicy.ThresholdType.Majority);
    }

    function test_AddRemoveMaintainer() public {
        assertEq(voting.maintainerCount(), 3);
        voting.setMaintainer(alice, false);
        assertEq(voting.maintainerCount(), 2);
        assertTrue(!voting.maintainers(alice));
    }

    function test_ConfigureFork() public {
        (uint256 quorum, VotingPolicy.ThresholdType tt) = voting.forkConfigs(forkId);
        assertEq(quorum, 2);
        assertEq(uint256(tt), uint256(VotingPolicy.ThresholdType.Majority));
    }

    function test_RevertInvalidQuorum() public {
        vm.expectRevert(VotingPolicy.InvalidQuorum.selector);
        voting.configureFork(forkId, 0, VotingPolicy.ThresholdType.Majority);
    }

    function test_VoteAndFinalizeMajority() public {
        uint256 proposalId = 1;

        vm.prank(alice);
        voting.vote(proposalId, true);

        vm.prank(bob);
        voting.vote(proposalId, true);

        bool passed = voting.finalize(proposalId, forkId);
        assertTrue(passed);
    }

    function test_VoteFailsQuorum() public {
        uint256 proposalId = 1;

        vm.prank(alice);
        voting.vote(proposalId, true);

        // Only 1 vote, quorum is 2
        bool passed = voting.finalize(proposalId, forkId);
        assertFalse(passed);
    }

    function test_VoteRejected() public {
        uint256 proposalId = 1;

        vm.prank(alice);
        voting.vote(proposalId, false);

        vm.prank(bob);
        voting.vote(proposalId, false);

        bool passed = voting.finalize(proposalId, forkId);
        assertFalse(passed);
    }

    function test_Supermajority() public {
        bytes32 fork2 = keccak256("fork-strict");
        voting.configureFork(fork2, 3, VotingPolicy.ThresholdType.Supermajority);

        uint256 proposalId = 1;

        vm.prank(alice);
        voting.vote(proposalId, true);
        vm.prank(bob);
        voting.vote(proposalId, true);
        vm.prank(charlie);
        voting.vote(proposalId, false);

        // 2/3 = 66.67% meets supermajority
        bool passed = voting.finalize(proposalId, fork2);
        assertTrue(passed);
    }

    function test_SupermajorityFails() public {
        bytes32 fork2 = keccak256("fork-strict");
        voting.configureFork(fork2, 2, VotingPolicy.ThresholdType.Supermajority);

        uint256 proposalId = 1;

        vm.prank(alice);
        voting.vote(proposalId, true);
        vm.prank(bob);
        voting.vote(proposalId, false);

        // 1/2 = 50%, not enough for supermajority
        bool passed = voting.finalize(proposalId, fork2);
        assertFalse(passed);
    }

    function test_Unanimous() public {
        bytes32 fork3 = keccak256("fork-unanimous");
        voting.configureFork(fork3, 3, VotingPolicy.ThresholdType.Unanimous);

        uint256 proposalId = 1;

        vm.prank(alice);
        voting.vote(proposalId, true);
        vm.prank(bob);
        voting.vote(proposalId, true);
        vm.prank(charlie);
        voting.vote(proposalId, true);

        bool passed = voting.finalize(proposalId, fork3);
        assertTrue(passed);
    }

    function test_UnanimousFails() public {
        bytes32 fork3 = keccak256("fork-unanimous");
        voting.configureFork(fork3, 3, VotingPolicy.ThresholdType.Unanimous);

        uint256 proposalId = 1;

        vm.prank(alice);
        voting.vote(proposalId, true);
        vm.prank(bob);
        voting.vote(proposalId, true);
        vm.prank(charlie);
        voting.vote(proposalId, false);

        bool passed = voting.finalize(proposalId, fork3);
        assertFalse(passed);
    }

    function test_Delegation() public {
        uint256 proposalId = 1;

        // Alice delegates to bob
        vm.prank(alice);
        voting.setDelegation(bob);

        // Alice votes, but it counts as bob's vote
        vm.prank(alice);
        voting.vote(proposalId, true);

        // Bob tries to vote — should revert since alice already voted as bob
        vm.prank(bob);
        vm.expectRevert(VotingPolicy.AlreadyVoted.selector);
        voting.vote(proposalId, true);
    }

    function test_RevertSelfDelegation() public {
        vm.prank(alice);
        vm.expectRevert(VotingPolicy.SelfDelegation.selector);
        voting.setDelegation(alice);
    }

    function test_RevertDoubleVote() public {
        uint256 proposalId = 1;

        vm.prank(alice);
        voting.vote(proposalId, true);

        vm.prank(alice);
        vm.expectRevert(VotingPolicy.AlreadyVoted.selector);
        voting.vote(proposalId, true);
    }

    function test_RevertNonMaintainer() public {
        vm.prank(address(0x99));
        vm.expectRevert(VotingPolicy.NotMaintainer.selector);
        voting.vote(1, true);
    }

    function test_RevertVoteAfterFinalized() public {
        uint256 proposalId = 1;
        vm.prank(alice);
        voting.vote(proposalId, true);
        vm.prank(bob);
        voting.vote(proposalId, true);

        voting.finalize(proposalId, forkId);

        vm.prank(charlie);
        vm.expectRevert(VotingPolicy.VoteAlreadyFinalized.selector);
        voting.vote(proposalId, true);
    }

    function test_RevertDoubleFinalze() public {
        uint256 proposalId = 1;
        vm.prank(alice);
        voting.vote(proposalId, true);
        vm.prank(bob);
        voting.vote(proposalId, true);

        voting.finalize(proposalId, forkId);

        vm.expectRevert(VotingPolicy.VoteAlreadyFinalized.selector);
        voting.finalize(proposalId, forkId);
    }

    function test_GetVoteState() public {
        uint256 proposalId = 1;
        vm.prank(alice);
        voting.vote(proposalId, true);

        VotingPolicy.VoteState memory vs = voting.getVoteState(proposalId);
        assertEq(vs.yesVotes, 1);
        assertEq(vs.noVotes, 0);
        assertFalse(vs.finalized);
    }

    function test_RemoveMaintainerClearsDelegation() public {
        vm.prank(alice);
        voting.setDelegation(bob);
        assertEq(voting.delegation(alice), bob);

        voting.setMaintainer(alice, false);
        assertEq(voting.delegation(alice), address(0));
    }
}

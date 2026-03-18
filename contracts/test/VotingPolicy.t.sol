// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {VotingPolicy} from "../VotingPolicy.sol";
import {TestBase} from "./utils/TestBase.sol";

contract VotingPolicyTest is TestBase {
    bytes32 private constant DEFAULT_FORK = keccak256("fork/default");
    bytes32 private constant ALT_FORK = keccak256("fork/alt");

    address private owner = address(0xA11CE);
    address private m1 = address(0x1001);
    address private m2 = address(0x1002);
    address private m3 = address(0x1003);
    address private m4 = address(0x1004);
    address private m5 = address(0x1005);
    address private outsider = address(0x9999);

    VotingPolicy private voting;

    function setUp() public {
        voting = new VotingPolicy(owner, DEFAULT_FORK, 5_000, VotingPolicy.ThresholdType.Majority);

        vm.prank(owner);
        voting.setMaintainer(m1, true);
        vm.prank(owner);
        voting.setMaintainer(m2, true);
        vm.prank(owner);
        voting.setMaintainer(m3, true);
        vm.prank(owner);
        voting.setMaintainer(m4, true);
        vm.prank(owner);
        voting.setMaintainer(m5, true);
    }

    function testMajorityApprovalWithDefaultFork() public {
        uint256 proposalId = 1;

        vm.prank(m1);
        voting.castVote(proposalId, VotingPolicy.VoteChoice.For);
        vm.prank(m2);
        voting.castVote(proposalId, VotingPolicy.VoteChoice.Against);
        vm.prank(m3);
        voting.castVote(proposalId, VotingPolicy.VoteChoice.For);

        (bool quorumMet, bool thresholdMet, bool approved) = voting.proposalResult(DEFAULT_FORK, proposalId);
        assertTrue(quorumMet, "quorum should be met");
        assertTrue(thresholdMet, "majority threshold should be met");
        assertTrue(approved, "proposal should be approved");
    }

    function testDelegationAccumulatesVotingPower() public {
        uint256 proposalId = 2;

        vm.prank(m1);
        voting.setDelegation(m2);

        vm.prank(m2);
        uint256 votingPower = voting.castVote(proposalId, VotingPolicy.VoteChoice.For);
        assertEq(votingPower, 2, "delegate should receive delegated power");

        VotingPolicy.VoteTally memory tally = voting.getVoteTally(DEFAULT_FORK, proposalId);
        assertEq(tally.forVotes, 2, "tally should include delegated weight");

        vm.prank(m1);
        vm.expectRevert(abi.encodeWithSelector(VotingPolicy.NoVotingPower.selector, m1));
        voting.castVote(proposalId, VotingPolicy.VoteChoice.For);
    }

    function testDelegationCycleReverts() public {
        vm.prank(m1);
        voting.setDelegation(m2);
        vm.prank(m2);
        voting.setDelegation(m3);

        vm.prank(m3);
        vm.expectRevert(VotingPolicy.DelegationCycle.selector);
        voting.setDelegation(m1);
    }

    function testPerForkSupermajorityPolicy() public {
        uint256 proposalId = 3;
        vm.prank(owner);
        voting.setForkPolicy(ALT_FORK, 6_000, VotingPolicy.ThresholdType.Supermajority);

        vm.prank(m1);
        voting.castVoteForFork(ALT_FORK, proposalId, VotingPolicy.VoteChoice.For);
        vm.prank(m2);
        voting.castVoteForFork(ALT_FORK, proposalId, VotingPolicy.VoteChoice.For);
        vm.prank(m3);
        voting.castVoteForFork(ALT_FORK, proposalId, VotingPolicy.VoteChoice.Against);

        (bool quorumMet, bool thresholdMet, bool approved) = voting.proposalResult(ALT_FORK, proposalId);
        assertTrue(quorumMet, "quorum should be met");
        assertTrue(thresholdMet, "2/3 support should pass supermajority");
        assertTrue(approved, "proposal should be approved");
    }

    function testPerForkUnanimousPolicy() public {
        uint256 proposalId = 4;
        vm.prank(owner);
        voting.setForkPolicy(ALT_FORK, 10_000, VotingPolicy.ThresholdType.Unanimous);

        vm.prank(m1);
        voting.castVoteForFork(ALT_FORK, proposalId, VotingPolicy.VoteChoice.For);
        vm.prank(m2);
        voting.castVoteForFork(ALT_FORK, proposalId, VotingPolicy.VoteChoice.For);
        vm.prank(m3);
        voting.castVoteForFork(ALT_FORK, proposalId, VotingPolicy.VoteChoice.For);
        vm.prank(m4);
        voting.castVoteForFork(ALT_FORK, proposalId, VotingPolicy.VoteChoice.For);
        vm.prank(m5);
        voting.castVoteForFork(ALT_FORK, proposalId, VotingPolicy.VoteChoice.For);

        (, bool thresholdMet, bool approved) = voting.proposalResult(ALT_FORK, proposalId);
        assertTrue(thresholdMet, "all maintainers should satisfy unanimous threshold");
        assertTrue(approved, "proposal should be approved");
    }

    function testNonMaintainerCannotVote() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(VotingPolicy.NotMaintainer.selector, outsider));
        voting.castVote(5, VotingPolicy.VoteChoice.For);
    }

    function testDelegateCannotVoteTwiceOnSameProposal() public {
        uint256 proposalId = 6;

        // m1 delegates to m2
        vm.prank(m1);
        voting.setDelegation(m2);

        // m2 votes with delegated power (2 votes)
        vm.prank(m2);
        voting.castVote(proposalId, VotingPolicy.VoteChoice.For);

        // Even if m2 receives new delegations, they cannot vote again
        vm.prank(m2);
        vm.expectRevert(
            abi.encodeWithSelector(VotingPolicy.AlreadyVoted.selector, m2, DEFAULT_FORK, proposalId)
        );
        voting.castVote(proposalId, VotingPolicy.VoteChoice.Against);
    }

    function testHasVoterVotedReturnsCorrectState() public {
        uint256 proposalId = 7;

        assertFalse(voting.hasVoterVoted(DEFAULT_FORK, proposalId, m1));

        vm.prank(m1);
        voting.castVote(proposalId, VotingPolicy.VoteChoice.For);

        assertTrue(voting.hasVoterVoted(DEFAULT_FORK, proposalId, m1));
        assertFalse(voting.hasVoterVoted(DEFAULT_FORK, proposalId, m2));
    }
}

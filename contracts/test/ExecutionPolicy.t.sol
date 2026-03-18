// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {GovernanceRegistry} from "../GovernanceRegistry.sol";
import {VotingPolicy} from "../VotingPolicy.sol";
import {ExecutionPolicy} from "../ExecutionPolicy.sol";
import {TestBase} from "./utils/TestBase.sol";

contract ExecutionPolicyTest is TestBase {
    bytes32 private constant DEFAULT_FORK = keccak256("fork/default");
    bytes32 private constant CONTENT_HASH = keccak256("execution-proposal");
    bytes32 private constant SCOPE_METADATA = keccak256("MUTATE_METADATA");

    address private owner = address(0xA11CE);
    address private proposer = address(0xBEEF);
    address private executor = address(0xC0DE);
    address private outsider = address(0xDEAD);

    address private m1 = address(0x1001);
    address private m2 = address(0x1002);
    address private m3 = address(0x1003);
    address private m4 = address(0x1004);
    address private m5 = address(0x1005);

    GovernanceRegistry private registry;
    VotingPolicy private voting;
    ExecutionPolicy private executionPolicy;

    function setUp() public {
        registry = new GovernanceRegistry(owner, DEFAULT_FORK);
        voting = new VotingPolicy(owner, DEFAULT_FORK, 5_000, VotingPolicy.ThresholdType.Majority);
        executionPolicy = new ExecutionPolicy(owner, address(registry), address(voting), executor);

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

    function testApprovedProposalCanConsumeAllowedScopeOnce() public {
        uint256 proposalId = _createProposalAndMarkApprovedInRegistry();
        _voteAllFor(proposalId);

        bytes32[] memory scopes = new bytes32[](1);
        scopes[0] = SCOPE_METADATA;
        vm.prank(owner);
        executionPolicy.defineProposalScopes(proposalId, DEFAULT_FORK, scopes);

        executionPolicy.approveProposalForExecution(proposalId);

        vm.prank(executor);
        executionPolicy.consumeScope(proposalId, SCOPE_METADATA);
        assertTrue(executionPolicy.isScopeConsumed(proposalId, SCOPE_METADATA), "scope should be consumed");

        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(ExecutionPolicy.ScopeAlreadyConsumed.selector, proposalId, SCOPE_METADATA)
        );
        executionPolicy.consumeScope(proposalId, SCOPE_METADATA);
    }

    function testDefineScopeTwiceRevertsToPreventScopeCreep() public {
        uint256 proposalId = _createProposalAndMarkApprovedInRegistry();
        _voteAllFor(proposalId);

        bytes32[] memory scopes = new bytes32[](1);
        scopes[0] = SCOPE_METADATA;

        vm.prank(owner);
        executionPolicy.defineProposalScopes(proposalId, DEFAULT_FORK, scopes);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ExecutionPolicy.ScopesAlreadyDefined.selector, proposalId));
        executionPolicy.defineProposalScopes(proposalId, DEFAULT_FORK, scopes);
    }

    function testConsentGateScopeRequiresSupermajority() public {
        uint256 proposalId = _createProposalAndMarkApprovedInRegistry();

        vm.prank(m1);
        voting.castVote(proposalId, VotingPolicy.VoteChoice.For);
        vm.prank(m2);
        voting.castVote(proposalId, VotingPolicy.VoteChoice.For);
        vm.prank(m3);
        voting.castVote(proposalId, VotingPolicy.VoteChoice.For);
        vm.prank(m4);
        voting.castVote(proposalId, VotingPolicy.VoteChoice.Against);
        vm.prank(m5);
        voting.castVote(proposalId, VotingPolicy.VoteChoice.Against);

        bytes32[] memory scopes = new bytes32[](1);
        scopes[0] = executionPolicy.CONSENT_GATE_SCOPE();
        vm.prank(owner);
        executionPolicy.defineProposalScopes(proposalId, DEFAULT_FORK, scopes);

        vm.expectRevert(abi.encodeWithSelector(ExecutionPolicy.MissingSupermajorityForConsentGate.selector, proposalId));
        executionPolicy.approveProposalForExecution(proposalId);
    }

    function testOnlyOwnerOrExecutorCanConsumeScope() public {
        uint256 proposalId = _createProposalAndMarkApprovedInRegistry();
        _voteAllFor(proposalId);

        bytes32[] memory scopes = new bytes32[](1);
        scopes[0] = SCOPE_METADATA;
        vm.prank(owner);
        executionPolicy.defineProposalScopes(proposalId, DEFAULT_FORK, scopes);
        executionPolicy.approveProposalForExecution(proposalId);

        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(ExecutionPolicy.UnauthorizedExecutor.selector, outsider));
        executionPolicy.consumeScope(proposalId, SCOPE_METADATA);
    }

    function testCancelledProposalCannotConsumeScope() public {
        uint256 proposalId = _createProposalAndMarkApprovedInRegistry();
        _voteAllFor(proposalId);

        bytes32[] memory scopes = new bytes32[](1);
        scopes[0] = SCOPE_METADATA;
        vm.prank(owner);
        executionPolicy.defineProposalScopes(proposalId, DEFAULT_FORK, scopes);

        executionPolicy.approveProposalForExecution(proposalId);

        // Cancel the proposal in the registry after execution approval
        vm.prank(owner);
        registry.updateProposalStatus(proposalId, GovernanceRegistry.ProposalStatus.Cancelled);

        // Attempt to consume scope should revert with live status check
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(ExecutionPolicy.ProposalNoLongerApproved.selector, proposalId));
        executionPolicy.consumeScope(proposalId, SCOPE_METADATA);
    }

    function _createProposalAndMarkApprovedInRegistry() private returns (uint256 proposalId) {
        vm.prank(proposer);
        proposalId = registry.createProposal(CONTENT_HASH);

        vm.prank(owner);
        registry.updateProposalStatus(proposalId, GovernanceRegistry.ProposalStatus.Active);
        vm.prank(owner);
        registry.updateProposalStatus(proposalId, GovernanceRegistry.ProposalStatus.Approved);
    }

    function _voteAllFor(uint256 proposalId) private {
        vm.prank(m1);
        voting.castVote(proposalId, VotingPolicy.VoteChoice.For);
        vm.prank(m2);
        voting.castVote(proposalId, VotingPolicy.VoteChoice.For);
        vm.prank(m3);
        voting.castVote(proposalId, VotingPolicy.VoteChoice.For);
        vm.prank(m4);
        voting.castVote(proposalId, VotingPolicy.VoteChoice.For);
        vm.prank(m5);
        voting.castVote(proposalId, VotingPolicy.VoteChoice.For);
    }
}

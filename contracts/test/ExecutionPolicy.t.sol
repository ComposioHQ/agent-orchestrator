// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ExecutionPolicy} from "../src/ExecutionPolicy.sol";

contract ExecutionPolicyTest is Test {
    event ExecutorUpdated(address indexed account, bool allowed);

    ExecutionPolicy policy;
    address owner = address(this);
    address executor = address(0x1);
    bytes32 scope1 = keccak256("scope-merge");
    bytes32 scope2 = keccak256("scope-deploy");

    function setUp() public {
        policy = new ExecutionPolicy(owner);
        policy.setExecutor(executor, true);
    }

    function test_AssignScope() public {
        policy.assignScope(1, scope1);
        assertEq(policy.scopeCount(1), 1);

        ExecutionPolicy.MutationScope memory s = policy.getScope(1, 0);
        assertEq(s.scopeHash, scope1);
        assertTrue(s.active);
    }

    function test_AssignMultipleScopes() public {
        policy.assignScope(1, scope1);
        policy.assignScope(1, scope2);
        assertEq(policy.scopeCount(1), 2);
    }

    function test_RevokeScope() public {
        policy.assignScope(1, scope1);
        policy.revokeScope(1, 0);

        ExecutionPolicy.MutationScope memory s = policy.getScope(1, 0);
        assertFalse(s.active);
    }

    function test_ExecuteProposal() public {
        policy.assignScope(1, scope1);

        vm.prank(executor);
        policy.execute(1);
    }

    function test_OwnerCanExecute() public {
        policy.assignScope(1, scope1);
        policy.execute(1);
    }

    function test_RevertExecuteNoScopes() public {
        vm.prank(executor);
        vm.expectRevert(ExecutionPolicy.NoScopes.selector);
        policy.execute(1);
    }

    function test_RevertExecuteRevokedScope() public {
        policy.assignScope(1, scope1);
        policy.revokeScope(1, 0);

        vm.prank(executor);
        vm.expectRevert(ExecutionPolicy.ScopeNotActive.selector);
        policy.execute(1);
    }

    function test_RevertNonExecutor() public {
        policy.assignScope(1, scope1);

        vm.prank(address(0x99));
        vm.expectRevert(ExecutionPolicy.NotExecutor.selector);
        policy.execute(1);
    }

    function test_ValidateScope() public {
        policy.assignScope(1, scope1);
        assertTrue(policy.validateScope(1, scope1));
        assertFalse(policy.validateScope(1, scope2));
    }

    function test_ValidateScopeAfterRevoke() public {
        policy.assignScope(1, scope1);
        policy.revokeScope(1, 0);
        assertFalse(policy.validateScope(1, scope1));
    }

    function test_ConsentGate() public {
        policy.setConsentGate(scope1, true);
        assertTrue(policy.consentGates(scope1));

        policy.setConsentGate(scope1, false);
        assertFalse(policy.consentGates(scope1));
    }

    function test_RevertRevokeOutOfBounds() public {
        vm.expectRevert(ExecutionPolicy.IndexOutOfBounds.selector);
        policy.revokeScope(1, 0);
    }

    function test_RevertGetScopeOutOfBounds() public {
        vm.expectRevert(ExecutionPolicy.IndexOutOfBounds.selector);
        policy.getScope(1, 0);
    }

    function test_RevertDoubleExecution() public {
        policy.assignScope(1, scope1);

        vm.prank(executor);
        policy.execute(1);

        vm.prank(executor);
        vm.expectRevert(ExecutionPolicy.AlreadyExecuted.selector);
        policy.execute(1);
    }

    function test_RevertConsentGateViolation() public {
        policy.assignScope(1, scope1);
        policy.setConsentGate(scope1, true);

        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(ExecutionPolicy.ConsentGateViolation.selector, scope1)
        );
        policy.execute(1);
    }

    function test_ExecuteAfterConsentGateCleared() public {
        policy.assignScope(1, scope1);
        policy.setConsentGate(scope1, true);
        policy.setConsentGate(scope1, false);

        vm.prank(executor);
        policy.execute(1);
    }

    function test_SetExecutorEmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit ExecutorUpdated(address(0x5), true);
        policy.setExecutor(address(0x5), true);
    }
}

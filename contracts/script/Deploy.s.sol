// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {GovernanceRegistry} from "../GovernanceRegistry.sol";
import {VotingPolicy} from "../VotingPolicy.sol";
import {ExecutionPolicy} from "../ExecutionPolicy.sol";
import {AttestationLog} from "../AttestationLog.sol";

/// @title Deploy
/// @notice Deploys all four AO governance contracts to Base and performs initial configuration.
/// @dev Usage:
///   forge script contracts/script/Deploy.s.sol:Deploy \
///     --rpc-url $BASE_RPC_URL --broadcast --verify \
///     --etherscan-api-key $BASESCAN_API_KEY -vvvv
contract Deploy is Script {
    /// @dev keccak256("ComposioHQ/agent-orchestrator") — canonical fork identifier for the main AO repo.
    bytes32 public constant AO_FORK_ID = keccak256("ComposioHQ/agent-orchestrator");

    /// @dev 50 % quorum — every maintainer's vote matters in a small set.
    uint16 public constant DEFAULT_QUORUM_BPS = 5_000;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address maintainer = vm.envOr("INITIAL_MAINTAINER", deployer);
        address ciAttester = vm.envOr("CI_ATTESTER", deployer);

        console2.log("Deployer:", deployer);
        console2.log("Initial maintainer:", maintainer);
        console2.log("CI attester:", ciAttester);
        console2.log("Fork ID (AO):", vm.toString(AO_FORK_ID));

        vm.startBroadcast(deployerKey);

        // 1. GovernanceRegistry
        GovernanceRegistry registry = new GovernanceRegistry(deployer, AO_FORK_ID);
        console2.log("GovernanceRegistry:", address(registry));

        // 2. VotingPolicy — Majority threshold for initial 1-of-1 governance
        VotingPolicy voting = new VotingPolicy(
            deployer,
            AO_FORK_ID,
            DEFAULT_QUORUM_BPS,
            VotingPolicy.ThresholdType.Majority
        );
        console2.log("VotingPolicy:", address(voting));

        // 3. ExecutionPolicy — deployer is initial mutation executor
        ExecutionPolicy execution = new ExecutionPolicy(deployer, address(registry), address(voting), deployer);
        console2.log("ExecutionPolicy:", address(execution));

        // 4. AttestationLog
        AttestationLog attestation = new AttestationLog(deployer);
        console2.log("AttestationLog:", address(attestation));

        // --- Initial configuration ---

        // Register the initial maintainer (1-of-1 threshold)
        voting.setMaintainer(maintainer, true);
        console2.log("Registered maintainer:", maintainer);

        // Grant the ExecutionPolicy contract status-manager rights so it can
        // drive proposal lifecycle transitions after voting approval.
        registry.setStatusManager(address(execution), true);
        console2.log("ExecutionPolicy set as status manager");

        // Authorize the CI attester to post attestations for merged PR outcomes
        attestation.setAttester(ciAttester, true);
        console2.log("CI attester authorized:", ciAttester);

        vm.stopBroadcast();

        // Print summary for governance.config.json
        console2.log("");
        console2.log("=== Deployment Summary ===");
        console2.log("Chain ID: 8453 (Base)");
        console2.log("GovernanceRegistry:", address(registry));
        console2.log("VotingPolicy:", address(voting));
        console2.log("ExecutionPolicy:", address(execution));
        console2.log("AttestationLog:", address(attestation));
    }
}

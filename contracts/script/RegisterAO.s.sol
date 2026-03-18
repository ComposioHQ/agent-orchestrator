// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {GovernanceRegistry} from "../GovernanceRegistry.sol";
import {VotingPolicy} from "../VotingPolicy.sol";
import {ExecutionPolicy} from "../ExecutionPolicy.sol";
import {AttestationLog} from "../AttestationLog.sol";

/// @title RegisterAO
/// @notice Post-deployment script to add maintainers or update configuration
///         on already-deployed governance contracts.
/// @dev Usage:
///   forge script contracts/script/RegisterAO.s.sol:RegisterAO \
///     --rpc-url $BASE_RPC_URL --broadcast -vvvv
contract RegisterAO is Script {
    bytes32 public constant AO_FORK_ID = keccak256("ComposioHQ/agent-orchestrator");

    function run() external {
        uint256 ownerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        address registryAddr = vm.envAddress("GOVERNANCE_REGISTRY");
        address votingAddr = vm.envAddress("VOTING_POLICY");
        address attestationAddr = vm.envAddress("ATTESTATION_LOG");

        GovernanceRegistry registry = GovernanceRegistry(registryAddr);
        VotingPolicy voting = VotingPolicy(votingAddr);
        AttestationLog attestation = AttestationLog(attestationAddr);

        vm.startBroadcast(ownerKey);

        // Add additional maintainers (comma-separated via env)
        string memory maintainersRaw = vm.envOr("ADD_MAINTAINERS", string(""));
        if (bytes(maintainersRaw).length > 0) {
            // Single address path — for multi-address, call this script multiple times
            // or extend with a custom parser.
            address newMaintainer = vm.parseAddress(maintainersRaw);
            voting.setMaintainer(newMaintainer, true);
            console2.log("Added maintainer:", newMaintainer);
        }

        // Add additional CI attesters
        string memory attestersRaw = vm.envOr("ADD_ATTESTERS", string(""));
        if (bytes(attestersRaw).length > 0) {
            address newAttester = vm.parseAddress(attestersRaw);
            attestation.setAttester(newAttester, true);
            console2.log("Added attester:", newAttester);
        }

        vm.stopBroadcast();

        // Verification reads
        console2.log("");
        console2.log("=== Current State ===");
        console2.log("Registry default fork:", vm.toString(registry.defaultForkId()));
        console2.log("Voting default fork:", vm.toString(voting.defaultForkId()));
        console2.log("Maintainer count:", voting.maintainerCount());
    }
}

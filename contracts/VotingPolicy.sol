// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @title VotingPolicy
/// @notice Maintainer-based governance voting with per-fork quorum and delegation.
contract VotingPolicy is Ownable {
    using EnumerableSet for EnumerableSet.AddressSet;

    enum ThresholdType {
        Majority,
        Supermajority,
        Unanimous
    }

    enum VoteChoice {
        Against,
        For,
        Abstain
    }

    struct ForkConfig {
        uint16 quorumBps;
        ThresholdType threshold;
        bool exists;
    }

    struct VoteTally {
        uint32 forVotes;
        uint32 againstVotes;
        uint32 abstainVotes;
    }

    error InvalidForkId();
    error InvalidQuorum(uint16 quorumBps);
    error NotMaintainer(address account);
    error InvalidDelegate(address delegatee);
    error DelegationCycle();
    error NoVotingPower(address voter);
    error InvalidProposal(uint256 proposalId);

    event MaintainerUpdated(address indexed maintainer, bool isActive);
    event ForkPolicyUpdated(bytes32 indexed forkId, uint16 quorumBps, ThresholdType thresholdType);
    event DelegationUpdated(address indexed delegator, address indexed delegatee);
    event VoteCast(
        bytes32 indexed forkId,
        uint256 indexed proposalId,
        address indexed voter,
        VoteChoice choice,
        uint256 votingPower
    );

    bytes32 public immutable defaultForkId;

    EnumerableSet.AddressSet private _maintainers;
    mapping(address => address) public delegationOf;
    mapping(bytes32 => ForkConfig) private _forkConfigs;
    mapping(bytes32 => mapping(uint256 => VoteTally)) private _voteTallies;
    mapping(bytes32 => mapping(uint256 => mapping(address => bool))) private _hasVotedByMaintainer;

    constructor(address initialOwner, bytes32 defaultForkId_, uint16 defaultQuorumBps, ThresholdType defaultThreshold)
        Ownable(initialOwner)
    {
        if (defaultForkId_ == bytes32(0)) revert InvalidForkId();
        if (defaultQuorumBps == 0 || defaultQuorumBps > 10_000) revert InvalidQuorum(defaultQuorumBps);

        defaultForkId = defaultForkId_;
        _forkConfigs[defaultForkId_] =
            ForkConfig({quorumBps: defaultQuorumBps, threshold: defaultThreshold, exists: true});

        emit ForkPolicyUpdated(defaultForkId_, defaultQuorumBps, defaultThreshold);
    }

    function setMaintainer(address maintainer, bool isActive) external onlyOwner {
        if (maintainer == address(0)) revert NotMaintainer(maintainer);

        if (isActive) {
            if (_maintainers.add(maintainer)) {
                emit MaintainerUpdated(maintainer, true);
            }
            return;
        }

        if (_maintainers.remove(maintainer)) {
            delete delegationOf[maintainer];
            uint256 count = _maintainers.length();
            for (uint256 i = 0; i < count; ++i) {
                address member = _maintainers.at(i);
                if (delegationOf[member] == maintainer) {
                    delete delegationOf[member];
                    emit DelegationUpdated(member, address(0));
                }
            }
            emit MaintainerUpdated(maintainer, false);
        }
    }

    function setForkPolicy(bytes32 forkId, uint16 quorumBps, ThresholdType threshold) external onlyOwner {
        if (forkId == bytes32(0)) revert InvalidForkId();
        if (quorumBps == 0 || quorumBps > 10_000) revert InvalidQuorum(quorumBps);

        _forkConfigs[forkId] = ForkConfig({quorumBps: quorumBps, threshold: threshold, exists: true});
        emit ForkPolicyUpdated(forkId, quorumBps, threshold);
    }

    function setDelegation(address delegatee) external {
        if (!_maintainers.contains(msg.sender)) revert NotMaintainer(msg.sender);

        if (delegatee == address(0)) {
            delete delegationOf[msg.sender];
            emit DelegationUpdated(msg.sender, address(0));
            return;
        }
        if (delegatee == msg.sender || !_maintainers.contains(delegatee)) {
            revert InvalidDelegate(delegatee);
        }
        if (_wouldCreateCycle(msg.sender, delegatee)) revert DelegationCycle();

        delegationOf[msg.sender] = delegatee;
        emit DelegationUpdated(msg.sender, delegatee);
    }

    function castVote(uint256 proposalId, VoteChoice choice) external returns (uint256 votingPower) {
        return castVoteForFork(defaultForkId, proposalId, choice);
    }

    function castVoteForFork(bytes32 forkId, uint256 proposalId, VoteChoice choice)
        public
        returns (uint256 votingPower)
    {
        if (proposalId == 0) revert InvalidProposal(proposalId);
        if (!_maintainers.contains(msg.sender)) revert NotMaintainer(msg.sender);
        _forkConfig(forkId);

        uint256 count = _maintainers.length();
        for (uint256 i = 0; i < count; ++i) {
            address maintainer = _maintainers.at(i);
            if (_hasVotedByMaintainer[forkId][proposalId][maintainer]) {
                continue;
            }
            if (_effectiveDelegate(maintainer) == msg.sender) {
                _hasVotedByMaintainer[forkId][proposalId][maintainer] = true;
                unchecked {
                    ++votingPower;
                }
            }
        }

        if (votingPower == 0) revert NoVotingPower(msg.sender);

        VoteTally storage tally = _voteTallies[forkId][proposalId];
        if (choice == VoteChoice.For) {
            tally.forVotes += uint32(votingPower);
        } else if (choice == VoteChoice.Against) {
            tally.againstVotes += uint32(votingPower);
        } else {
            tally.abstainVotes += uint32(votingPower);
        }

        emit VoteCast(forkId, proposalId, msg.sender, choice, votingPower);
    }

    function isMaintainer(address account) external view returns (bool) {
        return _maintainers.contains(account);
    }

    function maintainerCount() external view returns (uint256) {
        return _maintainers.length();
    }

    function maintainers() external view returns (address[] memory) {
        return _maintainers.values();
    }

    function getForkPolicy(bytes32 forkId) external view returns (ForkConfig memory) {
        return _forkConfig(forkId);
    }

    function getVoteTally(bytes32 forkId, uint256 proposalId) external view returns (VoteTally memory) {
        return _voteTallies[forkId][proposalId];
    }

    function hasMaintainerVoted(bytes32 forkId, uint256 proposalId, address maintainer) external view returns (bool) {
        return _hasVotedByMaintainer[forkId][proposalId][maintainer];
    }

    function effectiveDelegateOf(address maintainer) external view returns (address) {
        if (!_maintainers.contains(maintainer)) revert NotMaintainer(maintainer);
        return _effectiveDelegate(maintainer);
    }

    function proposalResult(bytes32 forkId, uint256 proposalId)
        public
        view
        returns (bool quorumMet, bool thresholdMet, bool approved)
    {
        ForkConfig memory cfg = _forkConfig(forkId);
        VoteTally memory tally = _voteTallies[forkId][proposalId];
        uint256 total = _maintainers.length();
        uint256 participation = uint256(tally.forVotes) + uint256(tally.againstVotes) + uint256(tally.abstainVotes);

        quorumMet = participation >= _requiredQuorumVotes(total, cfg.quorumBps);
        thresholdMet = _meetsThreshold(cfg.threshold, tally, total);
        approved = quorumMet && thresholdMet;
    }

    function isApproved(bytes32 forkId, uint256 proposalId) external view returns (bool) {
        (,, bool approved) = proposalResult(forkId, proposalId);
        return approved;
    }

    function isApprovedWithThreshold(bytes32 forkId, uint256 proposalId, ThresholdType threshold)
        external
        view
        returns (bool)
    {
        ForkConfig memory cfg = _forkConfig(forkId);
        VoteTally memory tally = _voteTallies[forkId][proposalId];
        uint256 total = _maintainers.length();
        uint256 participation = uint256(tally.forVotes) + uint256(tally.againstVotes) + uint256(tally.abstainVotes);
        bool quorumMet = participation >= _requiredQuorumVotes(total, cfg.quorumBps);
        return quorumMet && _meetsThreshold(threshold, tally, total);
    }

    function _forkConfig(bytes32 forkId) private view returns (ForkConfig memory cfg) {
        cfg = _forkConfigs[forkId];
        if (!cfg.exists) {
            cfg = _forkConfigs[defaultForkId];
        }
    }

    function _requiredQuorumVotes(uint256 maintainerTotal, uint16 quorumBps) private pure returns (uint256) {
        if (maintainerTotal == 0) {
            return 0;
        }
        return (maintainerTotal * quorumBps + 9_999) / 10_000;
    }

    function _meetsThreshold(ThresholdType threshold, VoteTally memory tally, uint256 maintainerTotal)
        private
        pure
        returns (bool)
    {
        if (threshold == ThresholdType.Unanimous) {
            return maintainerTotal > 0 && tally.forVotes == maintainerTotal;
        }

        uint256 decisiveVotes = uint256(tally.forVotes) + uint256(tally.againstVotes);
        if (decisiveVotes == 0) {
            return false;
        }

        if (threshold == ThresholdType.Majority) {
            return tally.forVotes > tally.againstVotes;
        }

        return uint256(tally.forVotes) * 3 >= decisiveVotes * 2;
    }

    function _effectiveDelegate(address maintainer) private view returns (address) {
        address cursor = maintainer;
        address next = delegationOf[cursor];

        while (next != address(0)) {
            cursor = next;
            next = delegationOf[cursor];
        }
        return cursor;
    }

    function _wouldCreateCycle(address delegator, address delegatee) private view returns (bool) {
        address cursor = delegatee;
        while (cursor != address(0)) {
            if (cursor == delegator) {
                return true;
            }
            cursor = delegationOf[cursor];
        }
        return false;
    }
}

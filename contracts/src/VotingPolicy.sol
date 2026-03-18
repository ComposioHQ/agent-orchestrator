// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title VotingPolicy
/// @notice Maintainer-based voting (no tokens) with configurable quorum, delegation,
///         and threshold types per fork.
contract VotingPolicy is Ownable {
    enum ThresholdType {
        Majority,
        Supermajority,
        Unanimous
    }

    struct ForkConfig {
        uint256 quorum;
        ThresholdType thresholdType;
    }

    struct VoteState {
        uint256 yesVotes;
        uint256 noVotes;
        bool finalized;
    }

    /// @notice Registered maintainers.
    mapping(address => bool) public maintainers;
    uint256 public maintainerCount;

    /// @notice forkId => fork-level voting configuration.
    mapping(bytes32 => ForkConfig) public forkConfigs;

    /// @notice delegator => delegate (a maintainer can delegate their vote).
    mapping(address => address) public delegation;

    /// @notice proposalId => VoteState
    mapping(uint256 => VoteState) public votes;

    /// @notice proposalId => voter => voted
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    event MaintainerUpdated(address indexed account, bool added);
    event ForkConfigured(bytes32 indexed forkId, uint256 quorum, ThresholdType thresholdType);
    event DelegationSet(address indexed delegator, address indexed delegate);
    event Voted(uint256 indexed proposalId, address indexed voter, bool support);
    event VoteFinalized(uint256 indexed proposalId, bool passed);

    error NotMaintainer();
    error AlreadyVoted();
    error VoteAlreadyFinalized();
    error SelfDelegation();
    error InvalidQuorum();
    error ForkNotConfigured();

    modifier onlyMaintainer() {
        if (!maintainers[msg.sender]) revert NotMaintainer();
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Add or remove a maintainer.
    function setMaintainer(address account, bool add) external onlyOwner {
        if (add && !maintainers[account]) {
            maintainers[account] = true;
            maintainerCount++;
        } else if (!add && maintainers[account]) {
            maintainers[account] = false;
            maintainerCount--;
            // Clear delegation when removing a maintainer
            if (delegation[account] != address(0)) {
                delegation[account] = address(0);
            }
        }
        emit MaintainerUpdated(account, add);
    }

    /// @notice Configure voting parameters for a fork.
    function configureFork(bytes32 forkId, uint256 quorum, ThresholdType thresholdType)
        external
        onlyOwner
    {
        if (quorum == 0) revert InvalidQuorum();
        forkConfigs[forkId] = ForkConfig({quorum: quorum, thresholdType: thresholdType});
        emit ForkConfigured(forkId, quorum, thresholdType);
    }

    /// @notice Delegate vote to another maintainer. Pass address(0) to revoke.
    function setDelegation(address delegate) external onlyMaintainer {
        if (delegate == msg.sender) revert SelfDelegation();
        delegation[msg.sender] = delegate;
        emit DelegationSet(msg.sender, delegate);
    }

    /// @notice Cast a vote on a proposal. Delegated votes are counted for the delegate.
    function vote(uint256 proposalId, bool support) external onlyMaintainer {
        VoteState storage vs = votes[proposalId];
        if (vs.finalized) revert VoteAlreadyFinalized();

        // Each msg.sender can only vote once, regardless of delegation changes
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted();
        hasVoted[proposalId][msg.sender] = true;

        // Resolve effective voter for delegation — also mark delegate as voted
        // to prevent both delegator and delegate from casting separate votes
        address effectiveVoter = delegation[msg.sender] != address(0)
            ? delegation[msg.sender]
            : msg.sender;
        if (effectiveVoter != msg.sender) {
            if (hasVoted[proposalId][effectiveVoter]) revert AlreadyVoted();
            hasVoted[proposalId][effectiveVoter] = true;
        }

        if (support) {
            vs.yesVotes++;
        } else {
            vs.noVotes++;
        }

        emit Voted(proposalId, effectiveVoter, support);
    }

    /// @notice Finalize a vote for a proposal under a given fork's configuration.
    /// @return passed Whether the proposal met the threshold.
    function finalize(uint256 proposalId, bytes32 forkId) external onlyOwner returns (bool passed) {
        VoteState storage vs = votes[proposalId];
        if (vs.finalized) revert VoteAlreadyFinalized();

        ForkConfig memory cfg = forkConfigs[forkId];
        if (cfg.quorum == 0) revert ForkNotConfigured();
        uint256 totalVotes = vs.yesVotes + vs.noVotes;

        passed = _meetsThreshold(vs.yesVotes, totalVotes, cfg.quorum, cfg.thresholdType);
        vs.finalized = true;

        emit VoteFinalized(proposalId, passed);
    }

    /// @notice Check if the yes votes meet the configured threshold.
    function _meetsThreshold(
        uint256 yesVotes,
        uint256 totalVotes,
        uint256 quorum,
        ThresholdType thresholdType
    ) internal pure returns (bool) {
        if (totalVotes < quorum) return false;

        if (thresholdType == ThresholdType.Majority) {
            return yesVotes * 2 > totalVotes; // > 50%
        }
        if (thresholdType == ThresholdType.Supermajority) {
            return yesVotes * 3 >= totalVotes * 2; // >= 66.67%
        }
        // Unanimous
        return yesVotes == totalVotes;
    }

    /// @notice View helper for vote state.
    function getVoteState(uint256 proposalId) external view returns (VoteState memory) {
        return votes[proposalId];
    }
}

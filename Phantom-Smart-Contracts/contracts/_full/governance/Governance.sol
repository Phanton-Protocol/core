// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {TimelockController} from "./TimelockController.sol";
import {ProtocolToken} from "../core/ProtocolToken.sol";

/**
 * @title Governance (upgrade voting — Module 1 hardened)
 * @notice Token-weighted proposal contract that gates UUPS upgrades through
 *         the OpenZeppelin-backed `TimelockController`.
 *
 * @dev Audit fixes vs. previous version:
 *
 *   1. **Vote BEFORE schedule** — `proposeUpgrade` no longer pre-schedules
 *      the call on the timelock. Scheduling happens in `queue()` after a
 *      successful vote (CRIT — previous flow leaked owner-driven proposals
 *      into the timelock with no vote required).
 *
 *   2. **Snapshot-based voting weight** — uses `ProtocolToken.getPastVotes`
 *      at the snapshot block. Prevents flash-loan voting.
 *
 *   3. **OZ Timelock API** — calls `schedule()` / `execute()` (not the
 *      now-removed custom `scheduleUpgrade` / `executeUpgrade`).
 *
 *   4. **Permissionless propose** by token holders who meet
 *      `minProposalThreshold` (no more `onlyOwner` proposer gate).
 *
 *   5. **Custom errors** for gas + clarity; **events** for every state change.
 *
 *   6. **`PROPOSER_ROLE` requirement** — this contract MUST hold
 *      `PROPOSER_ROLE` on the timelock for `queue()` to succeed. Deployment
 *      script grants it and renounces the admin role on the timelock.
 *
 * Lifecycle:
 *   propose() -> vote() ... -> [voting period ends + quorum + majority] ->
 *   queue()  -> [timelock delay elapses] -> execute()
 */
contract Governance {
    // ============ Types ============

    struct Proposal {
        address proposer;
        address target;
        uint256 value;
        bytes data;
        uint256 startBlock;
        uint256 endBlock;
        uint256 snapshotBlock;
        uint256 votesFor;
        uint256 votesAgainst;
        bool queued;
        bool executed;
        bool cancelled;
        bytes32 timelockSalt;
    }

    enum State {
        Pending,
        Active,
        Defeated,
        Succeeded,
        Queued,
        Executed,
        Cancelled
    }

    // ============ Errors ============

    error NotProposer();
    error NotGuardian();
    error InsufficientTokens();
    error VotingClosed();
    error VotingActive();
    error AlreadyVoted();
    error NoVotingPower();
    error QuorumNotMet();
    error NotApproved();
    error AlreadyQueued();
    error NotQueued();
    error AlreadyExecuted();
    error Cancelled();
    error ZeroAddress();
    error InvalidQuorum();
    error InvalidThreshold();
    error InvalidVotingPeriod();

    // ============ Immutable / Storage ============

    TimelockController public immutable timelock;
    ProtocolToken public immutable protocolToken;
    /// @notice Guardian may cancel proposals before execution (cannot create
    ///         or execute). MUST be a multisig; never an EOA in production.
    address public guardian;

    uint256 public immutable votingPeriodBlocks;
    uint256 public immutable quorum;
    uint256 public immutable minProposalThreshold;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) internal _proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    // ============ Events ============

    event ProposalCreated(
        uint256 indexed id,
        address indexed proposer,
        address indexed target,
        uint256 value,
        bytes data,
        uint256 endBlock,
        uint256 snapshotBlock
    );
    event Voted(uint256 indexed id, address indexed voter, bool support, uint256 weight);
    event ProposalQueued(uint256 indexed id, bytes32 operationId, uint256 executeAfter);
    event ProposalExecuted(uint256 indexed id);
    event ProposalCancelled(uint256 indexed id, address indexed by);
    event GuardianChanged(address indexed previousGuardian, address indexed newGuardian);

    // ============ Constructor ============

    constructor(
        address _timelock,
        address _protocolToken,
        address _guardian,
        uint256 _votingPeriodBlocks,
        uint256 _quorum,
        uint256 _minProposalThreshold
    ) {
        if (_timelock == address(0) || _protocolToken == address(0)) revert ZeroAddress();
        if (_votingPeriodBlocks == 0) revert InvalidVotingPeriod();
        if (_quorum == 0) revert InvalidQuorum();
        if (_minProposalThreshold == 0) revert InvalidThreshold();

        timelock = TimelockController(payable(_timelock));
        protocolToken = ProtocolToken(_protocolToken);
        guardian = _guardian;
        votingPeriodBlocks = _votingPeriodBlocks;
        quorum = _quorum;
        minProposalThreshold = _minProposalThreshold;

        emit GuardianChanged(address(0), _guardian);
    }

    // ============ Proposals ============

    /**
     * @notice Create a new upgrade/protocol proposal.
     * @dev Caller must hold at least `minProposalThreshold` tokens **and**
     *      have non-zero past votes at the snapshot block. No-op scheduling:
     *      this function does NOT touch the timelock.
     */
    function propose(
        address target,
        uint256 value,
        bytes calldata data
    ) external returns (uint256 id) {
        if (target == address(0)) revert ZeroAddress();

        id = ++proposalCount;
        uint256 snap = block.number == 0 ? 0 : block.number - 1;
        if (protocolToken.getPastVotes(msg.sender, snap) < minProposalThreshold) revert InsufficientTokens();
        Proposal storage p = _proposals[id];
        p.proposer = msg.sender;
        p.target = target;
        p.value = value;
        p.data = data;
        p.startBlock = block.number;
        p.endBlock = block.number + votingPeriodBlocks;
        p.snapshotBlock = snap;

        emit ProposalCreated(id, msg.sender, target, value, data, p.endBlock, snap);
    }

    /**
     * @notice Cast a vote using snapshot-block past-votes weight.
     * @param id Proposal id.
     * @param support true = for, false = against.
     */
    function vote(uint256 id, bool support) external {
        Proposal storage p = _proposals[id];
        if (block.number < p.startBlock || block.number > p.endBlock) revert VotingClosed();
        if (p.cancelled) revert Cancelled();
        if (hasVoted[id][msg.sender]) revert AlreadyVoted();

        uint256 weight = protocolToken.getPastVotes(msg.sender, p.snapshotBlock);
        if (weight == 0) revert NoVotingPower();
        hasVoted[id][msg.sender] = true;

        if (support) {
            p.votesFor += weight;
        } else {
            p.votesAgainst += weight;
        }
        emit Voted(id, msg.sender, support, weight);
    }

    /**
     * @notice Queue a successful proposal into the timelock.
     * @dev Requires: voting ended, quorum met, majority for. This contract
     *      MUST hold `PROPOSER_ROLE` on the timelock.
     */
    function queue(uint256 id) external returns (bytes32 operationId) {
        Proposal storage p = _proposals[id];
        if (block.number <= p.endBlock) revert VotingActive();
        if (p.cancelled) revert Cancelled();
        if (p.queued) revert AlreadyQueued();
        if (p.votesFor + p.votesAgainst < quorum) revert QuorumNotMet();
        if (p.votesFor <= p.votesAgainst) revert NotApproved();

        bytes32 salt = keccak256(abi.encode(id, block.chainid, address(this)));
        p.timelockSalt = salt;
        p.queued = true;

        timelock.schedule(p.target, p.value, p.data, bytes32(0), salt, timelock.getMinDelay());
        operationId = timelock.hashOperation(p.target, p.value, p.data, bytes32(0), salt);
        emit ProposalQueued(id, operationId, block.timestamp + timelock.getMinDelay());
    }

    /**
     * @notice Execute a queued proposal after the timelock delay.
     */
    function execute(uint256 id) external payable {
        Proposal storage p = _proposals[id];
        if (!p.queued) revert NotQueued();
        if (p.executed) revert AlreadyExecuted();
        if (p.cancelled) revert Cancelled();
        p.executed = true;
        timelock.execute{value: p.value}(p.target, p.value, p.data, bytes32(0), p.timelockSalt);
        emit ProposalExecuted(id);
    }

    /**
     * @notice Cancel a proposal before execution. Callable by the proposer
     *         (any time before execution) or by the guardian.
     */
    function cancel(uint256 id) external {
        Proposal storage p = _proposals[id];
        if (p.executed) revert AlreadyExecuted();
        if (p.cancelled) revert Cancelled();
        if (msg.sender != p.proposer && msg.sender != guardian) revert NotProposer();
        p.cancelled = true;
        if (p.queued) {
            bytes32 opId = timelock.hashOperation(
                p.target,
                p.value,
                p.data,
                bytes32(0),
                p.timelockSalt
            );
            // Will revert if guardian doesn't hold CANCELLER_ROLE on the timelock.
            timelock.cancel(opId);
        }
        emit ProposalCancelled(id, msg.sender);
    }

    /**
     * @notice Rotate the guardian. Only callable through the timelock itself
     *         (i.e. via a successful governance proposal).
     */
    function setGuardian(address newGuardian) external {
        if (msg.sender != address(timelock)) revert NotGuardian();
        emit GuardianChanged(guardian, newGuardian);
        guardian = newGuardian;
    }

    // ============ Views ============

    function getProposal(uint256 id) external view returns (Proposal memory) {
        return _proposals[id];
    }

    function state(uint256 id) external view returns (State) {
        Proposal storage p = _proposals[id];
        if (p.cancelled) return State.Cancelled;
        if (p.executed) return State.Executed;
        if (p.queued) return State.Queued;
        if (block.number <= p.endBlock) {
            return block.number < p.startBlock ? State.Pending : State.Active;
        }
        if (p.votesFor + p.votesAgainst < quorum || p.votesFor <= p.votesAgainst) return State.Defeated;
        return State.Succeeded;
    }
}

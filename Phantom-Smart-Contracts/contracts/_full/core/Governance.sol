// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Governance (LEGACY — DO NOT USE IN PRODUCTION)
 * @notice Superseded by `governance/Governance.sol` + OpenZeppelin `TimelockController`.
 * @dev Retained for ABI compatibility with early BSC-testnet deployments only.
 *      Does **not** use OZ timelock roles; `execute` performs a direct `target.call`.
 *      Production Path-B upgrades must use the hardened governance stack (48h+ delay).
 */

interface IProtocolToken {
    function balanceOf(address user) external view returns (uint256);
    function getPastVotes(address user, uint256 blockNumber) external view returns (uint256);
}

contract Governance {
    struct Proposal {
        address proposer;
        address target;
        uint256 value;
        bytes data;
        uint256 startBlock;
        uint256 endBlock;
        uint256 snapshotBlock;
        uint256 forVotes;
        uint256 againstVotes;
        bool executed;
    }

    IProtocolToken public token;
    uint256 public votingPeriod;
    uint256 public quorum;
    uint256 public minProposalThreshold;
    /// @notice Retained for storage-layout / ABI compatibility with the
    ///         deployed BSC-testnet contract. Module 1 audit note: this
    ///         field is **not** used for access control; all gating is via
    ///         token balance + snapshot votes. Treat as informational only.
    address public owner;

    uint256 public constant EXECUTION_DELAY = 2 days;
    mapping(uint256 => uint256) public queuedAt;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public voted;

    event ProposalCreated(uint256 indexed id, address proposer);
    event ProposalQueued(uint256 indexed id, uint256 executeAfter);
    event Voted(uint256 indexed id, address voter, bool support, uint256 weight);
    event Executed(uint256 indexed id);

    constructor(
        address _token,
        uint256 _votingPeriod,
        uint256 _quorum,
        uint256 _minProposalThreshold,
        address _owner
    ) {
        token = IProtocolToken(_token);
        votingPeriod = _votingPeriod;
        quorum = _quorum;
        minProposalThreshold = _minProposalThreshold;
        owner = _owner != address(0) ? _owner : msg.sender;
    }

    function propose(address target, uint256 value, bytes calldata data) external returns (uint256) {
        uint256 snap = block.number == 0 ? 0 : block.number - 1;
        require(
            token.getPastVotes(msg.sender, snap) >= minProposalThreshold,
            "Governance: insufficient voting power at snapshot"
        );
        uint256 id = ++proposalCount;
        proposals[id] = Proposal({
            proposer: msg.sender,
            target: target,
            value: value,
            data: data,
            startBlock: block.number,
            endBlock: block.number + votingPeriod,
            snapshotBlock: block.number - 1,
            forVotes: 0,
            againstVotes: 0,
            executed: false
        });
        emit ProposalCreated(id, msg.sender);
        return id;
    }

    function vote(uint256 id, bool support) external {
        Proposal storage p = proposals[id];
        require(block.number >= p.startBlock && block.number <= p.endBlock, "Governance: voting closed");
        require(!voted[id][msg.sender], "Governance: already voted");
        uint256 weight = token.getPastVotes(msg.sender, p.snapshotBlock);
        require(weight > 0, "Governance: no voting power at snapshot");
        voted[id][msg.sender] = true;
        if (support) {
            p.forVotes += weight;
        } else {
            p.againstVotes += weight;
        }
        emit Voted(id, msg.sender, support, weight);
    }

    function queue(uint256 id) external {
        Proposal storage p = proposals[id];
        require(block.number > p.endBlock, "Governance: voting active");
        require(p.forVotes + p.againstVotes >= quorum, "Governance: quorum not met");
        require(p.forVotes > p.againstVotes, "Governance: not passed");
        require(queuedAt[id] == 0, "Governance: already queued");
        queuedAt[id] = block.timestamp;
        emit ProposalQueued(id, block.timestamp + EXECUTION_DELAY);
    }

    function execute(uint256 id) external {
        Proposal storage p = proposals[id];
        require(!p.executed, "Governance: executed");
        require(queuedAt[id] > 0, "Governance: not queued");
        require(block.timestamp >= queuedAt[id] + EXECUTION_DELAY, "Governance: timelock active");
        p.executed = true;
        (bool ok, ) = p.target.call{value: p.value}(p.data);
        require(ok, "Governance: call failed");
        emit Executed(id);
    }
}

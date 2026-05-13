// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Minimal voting token surface: ERC20Votes-style checkpoints (see OpenZeppelin IERC5805 / ERC20Votes).
interface IGovernanceToken {
    function getPastVotes(address account, uint256 timepoint) external view returns (uint256);
}

contract Governance {
    struct Proposal {
        address proposer;
        address target;
        uint256 value;
        bytes data;
        uint256 snapshotBlock;
        uint256 startBlock;
        uint256 endBlock;
        uint256 forVotes;
        uint256 againstVotes;
        bool executed;
    }

    IGovernanceToken public token;
    uint256 public votingPeriod;
    uint256 public quorum;
    /// @notice Minimum getPastVotes(msg.sender, snapshot) at proposal time (same snapshot block as voting).
    uint256 public proposalThreshold;
    /// @notice Extra blocks after voting ends before execute (timelock-style delay).
    uint256 public executionDelay;
    uint256 public proposalCount;

    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public voted;

    event ProposalCreated(uint256 indexed id, address proposer, uint256 snapshotBlock);
    event Voted(uint256 indexed id, address voter, bool support, uint256 weight);
    event Executed(uint256 indexed id);

    constructor(
        address _token,
        uint256 _votingPeriod,
        uint256 _quorum,
        uint256 _proposalThreshold,
        uint256 _executionDelay
    ) {
        token = IGovernanceToken(_token);
        votingPeriod = _votingPeriod;
        quorum = _quorum;
        proposalThreshold = _proposalThreshold;
        executionDelay = _executionDelay;
    }

    function propose(address target, uint256 value, bytes calldata data) external returns (uint256) {
        uint256 snap = block.number == 0 ? 0 : block.number - 1;
        uint256 proposerPower = token.getPastVotes(msg.sender, snap);
        require(proposerPower >= proposalThreshold, "Governance: insufficient proposer power");

        uint256 id = ++proposalCount;
        proposals[id] = Proposal({
            proposer: msg.sender,
            target: target,
            value: value,
            data: data,
            snapshotBlock: snap,
            startBlock: block.number,
            endBlock: block.number + votingPeriod,
            forVotes: 0,
            againstVotes: 0,
            executed: false
        });
        emit ProposalCreated(id, msg.sender, snap);
        return id;
    }

    function vote(uint256 id, bool support) external {
        Proposal storage p = proposals[id];
        require(block.number >= p.startBlock && block.number <= p.endBlock, "Governance: voting closed");
        require(!voted[id][msg.sender], "Governance: already voted");
        uint256 weight = token.getPastVotes(msg.sender, p.snapshotBlock);
        require(weight > 0, "Governance: no voting power");
        voted[id][msg.sender] = true;
        if (support) {
            p.forVotes += weight;
        } else {
            p.againstVotes += weight;
        }
        emit Voted(id, msg.sender, support, weight);
    }

    function execute(uint256 id) external {
        Proposal storage p = proposals[id];
        require(!p.executed, "Governance: executed");
        require(block.number > p.endBlock + executionDelay, "Governance: not executable yet");
        require(p.forVotes + p.againstVotes >= quorum, "Governance: quorum not met");
        require(p.forVotes > p.againstVotes, "Governance: not passed");
        p.executed = true;
        (bool ok, ) = p.target.call{value: p.value}(p.data);
        require(ok, "Governance: call failed");
        emit Executed(id);
    }
}

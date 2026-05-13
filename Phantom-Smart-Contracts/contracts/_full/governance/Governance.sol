// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "./TimelockController.sol";
import "../core/ProtocolToken.sol";

/**
 * @title Governance
 * @notice Token-based governance for upgrade voting
 * @dev Uses ProtocolToken for weighted voting
 */
contract Governance {
    TimelockController public timelock;
    ProtocolToken public protocolToken;
    address public owner;
    
    uint256 public constant VOTING_PERIOD = 7 days;
    uint256 public constant QUORUM_THRESHOLD = 4; // 4% of total supply
    uint256 public constant APPROVAL_THRESHOLD = 50; // 50% of votes must be for
    
    struct Proposal {
        address target;
        bytes data;
        bytes32 operationId;
        uint256 snapshotBlock;
        uint256 votesFor;
        uint256 votesAgainst;
        uint256 startTime;
        uint256 endTime;
        bool executed;
        mapping(address => bool) hasVoted;
    }
    
    mapping(uint256 => Proposal) public proposals;
    uint256 public proposalCount;
    
    event ProposalCreated(uint256 indexed proposalId, address target, bytes32 operationId, uint256 endTime, uint256 snapshotBlock);
    event VoteCast(uint256 indexed proposalId, address voter, bool support, uint256 weight);
    event ProposalExecuted(uint256 indexed proposalId);
    
    modifier onlyOwner() {
        require(msg.sender == owner, "Governance: not owner");
        _;
    }
    
    constructor(address _timelock, address _protocolToken) {
        owner = msg.sender;
        timelock = TimelockController(_timelock);
        protocolToken = ProtocolToken(_protocolToken);
    }
    
    function proposeUpgrade(
        address target,
        bytes calldata data
    ) external onlyOwner returns (uint256 proposalId, bytes32 operationId) {
        proposalId = proposalCount++;
        Proposal storage proposal = proposals[proposalId];
        proposal.target = target;
        proposal.data = data;
        proposal.startTime = block.timestamp;
        proposal.endTime = block.timestamp + VOTING_PERIOD;
        proposal.snapshotBlock = block.number == 0 ? 0 : block.number - 1;
        
        // Schedule in timelock
        operationId = timelock.scheduleUpgrade(target, data);
        proposal.operationId = operationId;
        
        emit ProposalCreated(proposalId, target, operationId, proposal.endTime, proposal.snapshotBlock);
        return (proposalId, operationId);
    }
    
    function vote(uint256 proposalId, bool support) external {
        Proposal storage proposal = proposals[proposalId];
        require(block.timestamp <= proposal.endTime, "Governance: voting ended");
        require(!proposal.hasVoted[msg.sender], "Governance: already voted");
        require(!proposal.executed, "Governance: proposal executed");
        
        uint256 weight = protocolToken.getPastVotes(msg.sender, proposal.snapshotBlock);
        require(weight > 0, "Governance: no tokens");
        
        proposal.hasVoted[msg.sender] = true;
        if (support) {
            proposal.votesFor += weight;
        } else {
            proposal.votesAgainst += weight;
        }
        
        emit VoteCast(proposalId, msg.sender, support, weight);
    }
    
    function executeProposal(uint256 proposalId) external {
        Proposal storage proposal = proposals[proposalId];
        require(block.timestamp > proposal.endTime, "Governance: voting still active");
        require(!proposal.executed, "Governance: already executed");
        
        uint256 totalVotes = proposal.votesFor + proposal.votesAgainst;
        uint256 totalSupply = protocolToken.totalSupply();
        
        // Check quorum (4% of total supply)
        require(totalVotes >= (totalSupply * QUORUM_THRESHOLD) / 100, "Governance: quorum not met");
        
        // Check approval (50% of votes must be for)
        require(proposal.votesFor * 100 >= totalVotes * APPROVAL_THRESHOLD, "Governance: proposal not approved");
        
        // Execute through timelock
        timelock.executeUpgrade(proposal.target, proposal.data, proposal.operationId);
        proposal.executed = true;
        
        emit ProposalExecuted(proposalId);
    }
    
    function getProposal(uint256 proposalId) external view returns (
        address target,
        bytes32 operationId,
        uint256 votesFor,
        uint256 votesAgainst,
        uint256 endTime,
        bool executed,
        uint256 snapshotBlock
    ) {
        Proposal storage proposal = proposals[proposalId];
        return (
            proposal.target,
            proposal.operationId,
            proposal.votesFor,
            proposal.votesAgainst,
            proposal.endTime,
            proposal.executed,
            proposal.snapshotBlock
        );
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IVerifier.sol";

/**
 * @title DecentralizedVerifier
 * @notice Decentralized proof verification by staked validators
 * @dev Implements a voting-based verification system where stakers verify proofs off-chain
 *      and submit votes on-chain. Consensus determines acceptance.
 */
contract DecentralizedVerifier is IVerifier {
    address public immutable stakingContract;
    address public immutable protocolToken;
    uint256 public immutable votingPeriod; // seconds
    uint256 public immutable quorumBps; // basis points (e.g., 6600 = 66%)
    uint256 public immutable slashBps; // basis points to slash for wrong vote

    struct ProofSubmission {
        bytes32 proofHash;
        uint256 submittedAt;
        uint256 votesValid;
        uint256 votesInvalid;
        uint256 totalVotingPower;
        bool finalized;
        bool result;
        mapping(address => bool) hasVoted;
        mapping(address => bool) votedValid;
    }

    mapping(bytes32 => ProofSubmission) public proofs;
    uint256 public proofCount;

    event ProofSubmitted(bytes32 indexed proofHash, uint256 timestamp);
    event VoteCast(bytes32 indexed proofHash, address indexed voter, bool valid, uint256 votingPower);
    event ProofFinalized(bytes32 indexed proofHash, bool result, uint256 votesValid, uint256 votesInvalid);
    event VoterSlashed(address indexed voter, bytes32 indexed proofHash, uint256 amount);
    event VoterRewarded(address indexed voter, bytes32 indexed proofHash, uint256 amount);

    constructor(
        address _stakingContract,
        address _protocolToken,
        uint256 _votingPeriod,
        uint256 _quorumBps,
        uint256 _slashBps
    ) {
        require(_stakingContract != address(0), "DecentralizedVerifier: zero staking");
        require(_protocolToken != address(0), "DecentralizedVerifier: zero token");
        require(_votingPeriod > 0, "DecentralizedVerifier: zero voting period");
        require(_quorumBps > 0 && _quorumBps <= 10000, "DecentralizedVerifier: invalid quorum");
        require(_slashBps > 0 && _slashBps <= 10000, "DecentralizedVerifier: invalid slash");

        stakingContract = _stakingContract;
        protocolToken = _protocolToken;
        votingPeriod = _votingPeriod;
        quorumBps = _quorumBps;
        slashBps = _slashBps;
    }

    /**
     * @notice Submit a proof for decentralized verification
     * @dev Creates a voting round for the proof
     */
    function submitProof(bytes memory proof, uint256[] memory publicInputs) external returns (bytes32) {
        bytes32 proofHash = keccak256(abi.encodePacked(proof, publicInputs));
        require(proofs[proofHash].submittedAt == 0, "DecentralizedVerifier: proof already submitted");

        ProofSubmission storage submission = proofs[proofHash];
        submission.proofHash = proofHash;
        submission.submittedAt = block.timestamp;

        proofCount++;
        emit ProofSubmitted(proofHash, block.timestamp);
        return proofHash;
    }

    /**
     * @notice Staker votes on a proof (off-chain verification → on-chain vote)
     * @param proofHash The hash of the proof being voted on
     * @param valid True if the staker verified the proof is valid, false otherwise
     */
    function vote(bytes32 proofHash, bool valid) external {
        ProofSubmission storage submission = proofs[proofHash];
        require(submission.submittedAt > 0, "DecentralizedVerifier: proof not found");
        require(!submission.finalized, "DecentralizedVerifier: already finalized");
        require(block.timestamp < submission.submittedAt + votingPeriod, "DecentralizedVerifier: voting ended");
        require(!submission.hasVoted[msg.sender], "DecentralizedVerifier: already voted");

        // Get voting power from staking contract
        uint256 votingPower = _getVotingPower(msg.sender);
        require(votingPower > 0, "DecentralizedVerifier: no voting power");

        submission.hasVoted[msg.sender] = true;
        submission.votedValid[msg.sender] = valid;

        if (valid) {
            submission.votesValid += votingPower;
        } else {
            submission.votesInvalid += votingPower;
        }
        submission.totalVotingPower += votingPower;

        emit VoteCast(proofHash, msg.sender, valid, votingPower);
    }

    /**
     * @notice Finalize a proof after voting period ends
     * @dev Can be called by anyone after voting period
     */
    function finalize(bytes32 proofHash) external {
        ProofSubmission storage submission = proofs[proofHash];
        require(submission.submittedAt > 0, "DecentralizedVerifier: proof not found");
        require(!submission.finalized, "DecentralizedVerifier: already finalized");
        require(block.timestamp >= submission.submittedAt + votingPeriod, "DecentralizedVerifier: voting active");

        submission.finalized = true;

        // Check quorum and consensus
        uint256 totalStaked = _getTotalStaked();
        bool quorumReached = (submission.totalVotingPower * 10000) >= (totalStaked * quorumBps);
        
        if (quorumReached) {
            // Simple majority wins
            submission.result = submission.votesValid > submission.votesInvalid;
        } else {
            // No quorum = reject
            submission.result = false;
        }

        emit ProofFinalized(proofHash, submission.result, submission.votesValid, submission.votesInvalid);
    }

    /**
     * @notice Slash voters who voted incorrectly (called after finalization)
     * @dev Can slash voters who voted against the consensus
     */
    function slashIncorrectVoters(bytes32 proofHash, address[] calldata voters) external {
        ProofSubmission storage submission = proofs[proofHash];
        require(submission.finalized, "DecentralizedVerifier: not finalized");

        bool correctVote = submission.result;
        
        for (uint256 i = 0; i < voters.length; i++) {
            address voter = voters[i];
            if (submission.hasVoted[voter] && submission.votedValid[voter] != correctVote) {
                uint256 votingPower = _getVotingPower(voter);
                uint256 slashAmount = (votingPower * slashBps) / 10000;
                
                // Call staking contract to slash
                _slash(voter, slashAmount);
                emit VoterSlashed(voter, proofHash, slashAmount);
            }
        }
    }

    /**
     * @notice IVerifier interface - returns result if finalized
     */
    function verifyProof(
        Proof memory proof,
        uint256[] memory publicInputs
    ) external view override returns (bool) {
        bytes memory proofBytes = abi.encode(proof.a, proof.b, proof.c);
        bytes32 proofHash = keccak256(abi.encodePacked(proofBytes, publicInputs));
        
        ProofSubmission storage submission = proofs[proofHash];
        require(submission.finalized, "DecentralizedVerifier: not finalized");
        return submission.result;
    }

    /**
     * @notice Get proof status
     */
    function getProofStatus(bytes32 proofHash) external view returns (
        bool exists,
        bool finalized,
        bool result,
        uint256 votesValid,
        uint256 votesInvalid,
        uint256 timeRemaining
    ) {
        ProofSubmission storage submission = proofs[proofHash];
        exists = submission.submittedAt > 0;
        finalized = submission.finalized;
        result = submission.result;
        votesValid = submission.votesValid;
        votesInvalid = submission.votesInvalid;
        
        if (exists && !finalized && block.timestamp < submission.submittedAt + votingPeriod) {
            timeRemaining = (submission.submittedAt + votingPeriod) - block.timestamp;
        }
    }

    // ============ Internal Functions ============

    function _getVotingPower(address staker) internal view returns (uint256) {
        // Get staked balance from RelayerStaking contract
        (bool success, bytes memory data) = stakingContract.staticcall(
            abi.encodeWithSignature("stakedBalance(address)", staker)
        );
        require(success, "DecentralizedVerifier: staking call failed");
        return abi.decode(data, (uint256));
    }

    function _getTotalStaked() internal view returns (uint256) {
        (bool success, bytes memory data) = stakingContract.staticcall(
            abi.encodeWithSignature("totalStaked()")
        );
        require(success, "DecentralizedVerifier: total staked call failed");
        return abi.decode(data, (uint256));
    }

    function _slash(address staker, uint256 amount) internal {
        // Call staking contract to slash
        // Note: RelayerStaking would need a slash() function
        (bool success,) = stakingContract.call(
            abi.encodeWithSignature("slash(address,uint256)", staker, amount)
        );
        require(success, "DecentralizedVerifier: slash failed");
    }
}

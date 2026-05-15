// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;
pragma abicoder v2;

import "../interfaces/IVerifier.sol";

/**
 * @title ThresholdVerifier
 * @notice Instant proof verification via threshold signatures from staked validators
 * @dev Validators run off-chain servers that verify proofs and sign results.
 *      Contract aggregates signatures and accepts proofs if threshold is met.
 *      **Auxiliary** — Path-B also runs primary Groth16; not a substitute for it.
 */
contract ThresholdVerifier is IVerifier {
    /// @notice Max signatures per {submitValidations} call (DoS guard).
    uint256 public constant MAX_SIGNATURES_PER_SUBMISSION = 32;
    // Using storage instead of immutable to fix compiler optimization issue
    // Gas cost difference is minimal (only read once per transaction)
    address public stakingContract;
    uint256 public thresholdBps; // e.g., 6600 = 66% must sign

    struct ValidatorSignature {
        address validator;
        uint256 votingPower;
        bytes signature;
        uint256 timestamp; // Timestamp when signature was created
    }

    // Proof hash => total voting power that signed it as valid
    mapping(bytes32 => uint256) public proofValidations;
    
    // Proof hash => validator => has signed
    mapping(bytes32 => mapping(address => bool)) public hasSigned;
    
    // Proof hash => submission timestamp
    mapping(bytes32 => uint256) public proofSubmissionTime;
    
    // Proof hash => validator => signature timestamp (prevents replay)
    mapping(bytes32 => mapping(address => uint256)) public signatureTimestamps;
    
    // Time window for signature submission (seconds)
    uint256 public constant SIGNATURE_WINDOW = 300; // 5 minutes
    uint256 public constant PROOF_EXPIRY = 3600; // 1 hour

    event ProofValidated(bytes32 indexed proofHash, address indexed validator, uint256 votingPower);
    event ProofAccepted(bytes32 indexed proofHash, uint256 totalVotingPower);
    event ProofRejected(bytes32 indexed proofHash, string reason);
    event InvalidProofDetected(bytes32 indexed proofHash, address indexed validator);

    constructor(address _stakingContract, uint256 _thresholdBps) {
        require(_stakingContract != address(0), "ThresholdVerifier: zero staking");
        require(_thresholdBps > 0 && _thresholdBps <= 10000, "ThresholdVerifier: invalid threshold");
        
        stakingContract = _stakingContract;
        thresholdBps = _thresholdBps;
    }

    /**
     * @notice Submit validator signatures for a proof
     * @dev Anyone (relayer) can submit signatures on behalf of validators
     * @param proof The ZK-SNARK proof
     * @param publicInputs The public inputs to the proof
     * @param signatures Array of validator signatures
     * @param isValid True if proof is valid, false if invalid (for slashing)
     */
    function submitValidations(
        Proof memory proof,
        uint256[] memory publicInputs,
        ValidatorSignature[] memory signatures,
        bool isValid
    ) external {
        require(publicInputs.length == 9, "ThresholdVerifier: invalid public inputs");
        bytes32 proofHash = _hashProof(proof, publicInputs);
        uint256 currentTime = block.timestamp;
        
        // Reference storage variables to prevent optimization removal
        address staking = stakingContract;
        uint256 threshold = thresholdBps;
        // Use variables to prevent compiler optimization removal
        require(staking != address(0), "ThresholdVerifier: staking required");
        require(threshold > 0, "ThresholdVerifier: threshold required");
        
        // Initialize submission time if first signature
        if (proofSubmissionTime[proofHash] == 0) {
            proofSubmissionTime[proofHash] = currentTime;
        }
        
        // Check if proof window has expired
        uint256 expiry = PROOF_EXPIRY;
        require(
            currentTime <= proofSubmissionTime[proofHash] + expiry,
            "ThresholdVerifier: proof expired"
        );
        require(
            signatures.length <= MAX_SIGNATURES_PER_SUBMISSION,
            "ThresholdVerifier: too many signatures"
        );
        
        for (uint256 i = 0; i < signatures.length; i++) {
            ValidatorSignature memory sig = signatures[i];
            
            // Skip if already signed
            if (hasSigned[proofHash][sig.validator]) {
                continue;
            }
            
            // Verify validator is staked
            uint256 votingPower = _getVotingPower(sig.validator);
            require(votingPower > 0, "ThresholdVerifier: validator not staked");
            require(sig.votingPower == votingPower, "ThresholdVerifier: voting power mismatch");
            
            // Verify signature timestamp is within window
            require(
                sig.timestamp >= currentTime - SIGNATURE_WINDOW &&
                sig.timestamp <= currentTime + SIGNATURE_WINDOW,
                "ThresholdVerifier: signature expired"
            );
            
            // Verify signature (includes timestamp for replay protection)
            bytes32 message = keccak256(abi.encodePacked(proofHash, isValid, sig.timestamp));
            bytes32 ethSignedMessage = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", message));
            address signer = _recoverSigner(ethSignedMessage, sig.signature);
            require(signer == sig.validator, "ThresholdVerifier: invalid signature");
            
            // Record validation
            hasSigned[proofHash][sig.validator] = true;
            signatureTimestamps[proofHash][sig.validator] = sig.timestamp;
            
            if (isValid) {
                proofValidations[proofHash] += votingPower;
                emit ProofValidated(proofHash, sig.validator, votingPower);
            } else {
                // Invalid proof - emit event for slashing
                emit InvalidProofDetected(proofHash, sig.validator);
            }
        }
    }
    
    /**
     * @notice Report invalid proof and slash validators who signed it
     * @dev Can be called by anyone who can prove a proof is invalid
     * @param proofHash The proof hash
     * @param validators Array of validators who incorrectly signed
     */
    function reportInvalidProof(
        bytes32 proofHash,
        address[] calldata validators
    ) external {
        require(proofSubmissionTime[proofHash] > 0, "ThresholdVerifier: proof not found");
        
        // Reference storage variables to prevent optimization removal
        address stakingAddr = stakingContract;
        uint256 threshold = thresholdBps;
        require(stakingAddr != address(0), "ThresholdVerifier: staking required");
        require(threshold > 0, "ThresholdVerifier: threshold required");
        
        // Verify proof is actually invalid (would need on-chain verification)
        // For now, we'll rely on cryptographic proof verification in ShieldedPool
        // This function can be called if ShieldedPool rejects a proof that validators approved
        
        // Slash validators who signed invalid proof
        IRelayerStaking staking = IRelayerStaking(stakingAddr);
        for (uint256 i = 0; i < validators.length; i++) {
            if (hasSigned[proofHash][validators[i]]) {
                uint256 votingPower = _getVotingPower(validators[i]);
                uint256 slashAmount = (votingPower * 100) / 10000; // 1% slash
                staking.slash(validators[i], slashAmount);
            }
        }
    }

    /**
     * @notice Verify a proof using threshold consensus
     * @dev Returns true if enough validators have signed AND proof is not expired
     */
    function verifyProof(
        Proof memory proof,
        uint256[] memory publicInputs
    ) external view override returns (bool) {
        if (publicInputs.length != 9) {
            return false;
        }
        bytes32 proofHash = _hashProof(proof, publicInputs);
        uint256 submissionTime = proofSubmissionTime[proofHash];
        
        // Check if proof exists and is not expired
        if (submissionTime == 0) {
            return false; // Proof not submitted yet
        }
        
        if (block.timestamp > submissionTime + PROOF_EXPIRY) {
            return false; // Proof expired
        }
        
        uint256 totalStaked = _getTotalStaked();
        uint256 validations = proofValidations[proofHash];
        
        // Check if threshold is met (use thresholdBps to prevent optimization removal)
        uint256 threshold = thresholdBps;
        return (validations * 10000) >= (totalStaked * threshold);
    }

    /**
     * @notice Check if a proof has enough validations
     */
    function isProofValid(bytes32 proofHash) external view returns (bool, uint256, uint256) {
        uint256 totalStaked = _getTotalStaked();
        uint256 validations = proofValidations[proofHash];
        uint256 threshold = thresholdBps;
        require(threshold > 0, "ThresholdVerifier: threshold required");
        bool valid = (validations * 10000) >= (totalStaked * threshold);
        
        return (valid, validations, totalStaked);
    }

    /**
     * @notice Get the number of validators that have signed a proof
     */
    function getValidationCount(bytes32 proofHash, address[] calldata validators) external view returns (uint256) {
        uint256 count = 0;
        for (uint256 i = 0; i < validators.length; i++) {
            if (hasSigned[proofHash][validators[i]]) {
                count++;
            }
        }
        return count;
    }

    // ============ Internal Functions ============

    function _hashProof(Proof memory proof, uint256[] memory publicInputs) internal pure returns (bytes32) {
        return keccak256(abi.encode(proof.a, proof.b, proof.c, publicInputs));
    }

    function _getVotingPower(address validator) internal view returns (uint256) {
        address staking = stakingContract;
        require(staking != address(0), "ThresholdVerifier: staking required");
        (bool success, bytes memory data) = staking.staticcall(
            abi.encodeWithSignature("stakedBalance(address)", validator)
        );
        require(success, "ThresholdVerifier: staking call failed");
        return abi.decode(data, (uint256));
    }

    function _getTotalStaked() internal view returns (uint256) {
        address staking = stakingContract;
        require(staking != address(0), "ThresholdVerifier: staking required");
        (bool success, bytes memory data) = staking.staticcall(
            abi.encodeWithSignature("totalStaked()")
        );
        require(success, "ThresholdVerifier: total staked call failed");
        return abi.decode(data, (uint256));
    }

    function _recoverSigner(bytes32 ethSignedMessage, bytes memory signature) internal pure returns (address) {
        require(signature.length == 65, "ThresholdVerifier: invalid signature length");
        
        bytes32 r;
        bytes32 s;
        uint8 v;
        
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        
        if (v < 27) {
            v += 27;
        }
        
        require(v == 27 || v == 28, "ThresholdVerifier: invalid signature v");
        
        return ecrecover(ethSignedMessage, v, r, s);
    }
    
}

interface IRelayerStaking {
    function slash(address staker, uint256 amount) external;
}

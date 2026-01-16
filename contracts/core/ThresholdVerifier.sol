// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IVerifier.sol";

/**
 * @title ThresholdVerifier
 * @notice Instant proof verification via threshold signatures from staked validators
 * @dev Validators run off-chain servers that verify proofs and sign results.
 *      Contract aggregates signatures and accepts proofs if threshold is met.
 */
contract ThresholdVerifier is IVerifier {
    address public immutable stakingContract;
    uint256 public immutable thresholdBps; // e.g., 6600 = 66% must sign

    struct ValidatorSignature {
        address validator;
        uint256 votingPower;
        bytes signature;
    }

    // Proof hash => total voting power that signed it as valid
    mapping(bytes32 => uint256) public proofValidations;
    
    // Proof hash => validator => has signed
    mapping(bytes32 => mapping(address => bool)) public hasSigned;

    event ProofValidated(bytes32 indexed proofHash, address indexed validator, uint256 votingPower);
    event ProofAccepted(bytes32 indexed proofHash, uint256 totalVotingPower);
    event ProofRejected(bytes32 indexed proofHash, string reason);

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
     */
    function submitValidations(
        Proof memory proof,
        uint256[] memory publicInputs,
        ValidatorSignature[] memory signatures
    ) external {
        bytes32 proofHash = _hashProof(proof, publicInputs);
        
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
            
            // Verify signature
            bytes32 message = keccak256(abi.encodePacked(proofHash, true)); // true = valid
            bytes32 ethSignedMessage = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", message));
            address signer = _recoverSigner(ethSignedMessage, sig.signature);
            require(signer == sig.validator, "ThresholdVerifier: invalid signature");
            
            // Record validation
            hasSigned[proofHash][sig.validator] = true;
            proofValidations[proofHash] += votingPower;
            
            emit ProofValidated(proofHash, sig.validator, votingPower);
        }
    }

    /**
     * @notice Verify a proof using threshold consensus
     * @dev Returns true if enough validators have signed
     */
    function verifyProof(
        Proof memory proof,
        uint256[] memory publicInputs
    ) external view override returns (bool) {
        bytes32 proofHash = _hashProof(proof, publicInputs);
        uint256 totalStaked = _getTotalStaked();
        uint256 validations = proofValidations[proofHash];
        
        // Check if threshold is met
        return (validations * 10000) >= (totalStaked * thresholdBps);
    }

    /**
     * @notice Check if a proof has enough validations
     */
    function isProofValid(bytes32 proofHash) external view returns (bool, uint256, uint256) {
        uint256 totalStaked = _getTotalStaked();
        uint256 validations = proofValidations[proofHash];
        bool valid = (validations * 10000) >= (totalStaked * thresholdBps);
        
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
        (bool success, bytes memory data) = stakingContract.staticcall(
            abi.encodeWithSignature("stakedBalance(address)", validator)
        );
        require(success, "ThresholdVerifier: staking call failed");
        return abi.decode(data, (uint256));
    }

    function _getTotalStaked() internal view returns (uint256) {
        (bool success, bytes memory data) = stakingContract.staticcall(
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

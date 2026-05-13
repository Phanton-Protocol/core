// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./AdvancedPrivacyPool.sol";
import "./SelectiveDisclosure.sol" as SelectiveDisclosureContract;
import "./ThresholdEncryption.sol";
import "./FHECoprocessor.sol";

/**
 * @title EncryptedPool
 * @notice Complete encrypted privacy pool with FHE, MPC, selective disclosure, and threshold encryption
 * @dev Extends AdvancedPrivacyPool with all Phase 3 features integrated
 * 
 * Features:
 * - FHE encrypted swaps (Zama fhEVM)
 * - MPC order matching (Arcium)
 * - Selective disclosure proofs
 * - Threshold encrypted mempool (anti-MEV)
 * - Client-side proof generation (Plonky3/Halo2)
 */
contract EncryptedPool is AdvancedPrivacyPool {
    
    // ============ State Variables ============
    
    /// @notice Selective disclosure contract address
    address public immutable selectiveDisclosureAddress;
    
    /// @notice FHE coprocessor contract address
    address public immutable fheCoprocessorAddress;
    
    /// @notice Local reference to threshold encryption for convenience
    ThresholdEncryption private immutable _thresholdEncryptionContract;
    
    // ============ Events ============
    
    event EncryptedPoolInitialized(
        address indexed selectiveDisclosure,
        address indexed thresholdEncryption,
        address indexed fheCoprocessor
    );
    
    // ============ Constructor ============
    
    constructor(
        address _verifier,
        address _thresholdVerifier,
        address _swapAdaptor,
        address _feeOracle,
        address _relayerRegistry,
        address _fheCoprocessor,
        address _selectiveDisclosure,
        address _thresholdEncryption
    ) AdvancedPrivacyPool(
        _verifier,
        _thresholdVerifier,
        _swapAdaptor,
        _feeOracle,
        _relayerRegistry,
        _fheCoprocessor, // fheExecutor
        address(0), // mpcCoprocessor (can be set later)
        _thresholdEncryption
    ) {
        require(_fheCoprocessor != address(0), "EncryptedPool: zero FHE coprocessor");
        require(_selectiveDisclosure != address(0), "EncryptedPool: zero selective disclosure");
        require(_thresholdEncryption != address(0), "EncryptedPool: zero threshold encryption");
        
        fheCoprocessorAddress = _fheCoprocessor;
        selectiveDisclosureAddress = _selectiveDisclosure;
        _thresholdEncryptionContract = ThresholdEncryption(_thresholdEncryption);
        
        emit EncryptedPoolInitialized(
            _selectiveDisclosure,
            _thresholdEncryption,
            _fheCoprocessor
        );
    }
    
    // ============ Enhanced Functions ============
    
    /**
     * @notice Submit FHE swap with integrated coprocessor
     * @param encryptedAmountIn FHE encrypted input amount
     * @param encryptedAmountOut FHE encrypted output amount
     * @param commitment Output commitment
     * @param proof ZK proof
     * @return executionId Execution identifier
     */
    function submitFHESwap(
        bytes calldata encryptedAmountIn,
        bytes calldata encryptedAmountOut,
        bytes32 commitment,
        bytes calldata proof
    ) external nonReentrant override returns (bytes32 executionId) {
        require(
            userPrivacyMode[msg.sender] >= PrivacyMode.STANDARD,
            "FHE swaps require STANDARD mode or higher"
        );

        // CEI: persist commitment before external call (matches AdvancedPrivacyPool; avoids reentrancy window)
        encryptedCommitments[commitment] = encryptedAmountOut;

        // Call immutable coprocessor only (trusted per Wake: address set once in constructor)
        executionId = FHECoprocessor(fheCoprocessorAddress).submitEncryptedSwap(
            encryptedAmountIn,
            encryptedAmountOut,
            commitment,
            proof
        );

        emit FHESwapSubmitted(
            msg.sender,
            keccak256(encryptedAmountIn),
            keccak256(encryptedAmountOut),
            executionId
        );
        
        return executionId;
    }
    
    /**
     * @notice Submit selective disclosure proof
     * @param disclosureTypeValue Type of disclosure (0=BALANCE_RANGE, 1=SOURCE_OF_FUNDS, 2=TAX_LIABILITY, 3=KYC_STATUS)
     * @param proof ZK proof bytes
     * @param publicInputs Public inputs for verification
     * @param predicate Predicate description
     * @return proofHash Proof hash
     */
    function submitSelectiveDisclosure(
        uint8 disclosureTypeValue,
        bytes calldata proof,
        uint256[] calldata publicInputs,
        bytes calldata predicate
    ) external returns (bytes32 proofHash) {
        // Call selective disclosure contract using low-level call to handle enum
        bytes memory callData = abi.encodeWithSelector(
            bytes4(keccak256("submitProof(uint8,bytes,uint256[],bytes)")),
            disclosureTypeValue,
            proof,
            publicInputs,
            predicate
        );
        (bool success, bytes memory result) = selectiveDisclosureAddress.call(callData);
        require(success, "EncryptedPool: selective disclosure call failed");
        proofHash = abi.decode(result, (bytes32));
        
        // Also store in parent contract for compatibility
        disclosureProofs[msg.sender].push(proofHash);
        
        emit SelectiveDisclosureProof(
            msg.sender,
            DisclosureType(disclosureTypeValue),
            proofHash
        );
        
        return proofHash;
    }
    
    /**
     * @notice Submit encrypted transaction with threshold encryption
     * @param txData Transaction data
     * @param threshold Decryption threshold
     * @return ciphertext Encrypted transaction
     */
    function submitEncryptedTransaction(
        bytes calldata txData,
        uint256 threshold
    ) external override returns (bytes memory ciphertext) {
        // Use integrated threshold encryption (via parent's thresholdEncryption)
        ciphertext = thresholdEncryption.encryptTransaction(txData, threshold);
        
        return ciphertext;
    }
    
    /**
     * @notice Get FHE execution result
     * @param executionId Execution identifier
     * @return encryptedResult Encrypted result
     */
    function getFHEResult(bytes32 executionId)
        external
        view
        returns (bytes memory encryptedResult)
    {
        FHECoprocessor fheCoprocessor = FHECoprocessor(fheCoprocessorAddress);
        return fheCoprocessor.getEncryptedResult(executionId);
    }
    
    /**
     * @notice Verify selective disclosure proof
     * @param user User address
     * @param proofHash Proof hash
     * @return valid True if proof is valid
     */
    function verifySelectiveDisclosure(
        address user,
        bytes32 proofHash
    ) external view returns (bool valid) {
        (valid, ) = SelectiveDisclosureContract.SelectiveDisclosure(selectiveDisclosureAddress).verifyProof(user, proofHash);
        return valid;
    }
    
    /**
     * @notice Check if transaction is decrypted
     * @param txHash Transaction hash
     * @return decrypted True if decrypted
     */
    function isTransactionDecrypted(bytes32 txHash)
        external
        view
        returns (bool decrypted)
    {
        return _thresholdEncryptionContract.isDecrypted(txHash);
    }
    
    /**
     * @notice Get decrypted transaction
     * @param txHash Transaction hash
     * @return plaintext Decrypted transaction data
     */
    function getDecryptedTransaction(bytes32 txHash)
        external
        view
        returns (bytes memory plaintext)
    {
        return _thresholdEncryptionContract.getDecryptedTransaction(txHash);
    }
}

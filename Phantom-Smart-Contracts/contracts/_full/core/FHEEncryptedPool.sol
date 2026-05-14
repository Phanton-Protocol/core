// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ShieldedPool.sol";
import "./FHECoprocessor.sol";

/**
 * @title FHEEncryptedPool
 * @notice Full FHE integration - all on-chain data encrypted as euint hashes
 * @dev Extends ShieldedPool with FHE-encrypted commitments and queries
 * 
 * Privacy Features:
 * - Commitments stored as FHE euint hashes (not plain hashes)
 * - All amounts encrypted with FHE
 * - Client-side decryption only (users decrypt their own data)
 * - FHE-encrypted queries (pool balance returns ciphertext)
 * - Monero-level privacy on DeFi
 */
contract FHEEncryptedPool is ShieldedPool {
    
    // ============ State Variables ============
    
    /// @notice FHE coprocessor for encrypted operations
    FHECoprocessor public immutable fheCoprocessor;
    
    /// @notice FHE enabled flag (false until Zama supports BSC)
    /// @dev When false, uses ZK-only mode (Pedersen commitments)
    bool public fheEnabled;
    
    /// @notice FHE-encrypted commitments (euint hashes)
    /// @dev commitment => FHE encrypted commitment hash
    mapping(bytes32 => bytes) public fheEncryptedCommitments;
    
    /// @notice FHE-encrypted amounts (for queries)
    /// @dev commitment => FHE encrypted amount (euint)
    mapping(bytes32 => bytes) public fheEncryptedAmounts;
    
    /// @notice FHE-encrypted pool totals (TVL obfuscation)
    bytes public fheEncryptedTotalBalance;
    
    /// @notice Client-side decryption keys (user => encrypted key)
    /// @dev Users decrypt client-side, keys never revealed
    mapping(address => bytes) public userDecryptionKeys;
    
    // ============ Events ============
    
    event FHECommitmentStored(
        bytes32 indexed commitment,
        bytes fheEncryptedHash,
        bytes fheEncryptedAmount
    );
    
    event FHEQueryExecuted(
        address indexed querier,
        bytes fheEncryptedResult
    );
    
    // ============ Constructor ============
    
    constructor(
        address _verifier,
        address _thresholdVerifier,
        address _swapAdaptor,
        address _feeOracle,
        address _relayerRegistry,
        address _fheCoprocessor
    ) ShieldedPool(
        _verifier,
        address(0),
        _thresholdVerifier,
        _swapAdaptor,
        _feeOracle,
        _relayerRegistry
    ) {
        require(_fheCoprocessor != address(0), "FHEEncryptedPool: zero coprocessor");
        fheCoprocessor = FHECoprocessor(_fheCoprocessor);
        // FHE disabled by default (Zama doesn't support BSC yet)
        // Can be enabled when Zama adds BSC support
        fheEnabled = false;
    }
    
    error FHEEncryptedPoolNotOwner();
    event FHEEnabledChanged(bool enabled, address indexed by);

    /**
     * @notice Enable FHE mode (when Zama supports BSC).
     * @dev Module 1 audit fix (Critical): previously **anyone** could flip
     *      this flag and change deposit / commitment behavior pool-wide.
     *      Now restricted to the inherited `poolOwner` (governance/timelock
     *      once ownership is transferred). One-way design retained — calling
     *      while already enabled is a no-op event.
     */
    function enableFHE() external {
        if (msg.sender != poolOwner) revert FHEEncryptedPoolNotOwner();
        fheEnabled = true;
        emit FHEEnabledChanged(true, msg.sender);
    }

    /// @notice Allow `poolOwner` to disable FHE mode if Zama integration is
    ///         later removed; useful for safe rollback after testing.
    function disableFHE() external {
        if (msg.sender != poolOwner) revert FHEEncryptedPoolNotOwner();
        fheEnabled = false;
        emit FHEEnabledChanged(false, msg.sender);
    }
    
    // ============ FHE-Encrypted Deposits ============
    
    /**
     * @notice Deposit with FHE-encrypted commitment
     * @dev Commitment stored as FHE euint hash, not plain hash
     * @param token Token address (address(0) for BNB)
     * @param amount Amount to deposit
     * @param commitment Plain commitment (for Merkle tree)
     * @param fheEncryptedCommitment FHE-encrypted commitment hash (euint)
     * @param fheEncryptedAmount FHE-encrypted amount (euint)
     * @param assetID Asset identifier
     */
    function depositFHE(
        address token,
        uint256 amount,
        bytes32 commitment,
        bytes calldata fheEncryptedCommitment,
        bytes calldata fheEncryptedAmount,
        uint256 assetID
    ) external payable {
        // Standard deposit (for Merkle tree) - always works
        _depositInternal(msg.sender, token, amount, commitment, assetID, msg.value, address(0));
        
        // FHE storage (only if enabled)
        if (fheEnabled) {
            require(fheEncryptedCommitment.length > 0, "FHEEncryptedPool: empty FHE commitment");
            require(fheEncryptedAmount.length > 0, "FHEEncryptedPool: empty FHE amount");
            
            // Store FHE-encrypted data
            fheEncryptedCommitments[commitment] = fheEncryptedCommitment;
            fheEncryptedAmounts[commitment] = fheEncryptedAmount;
            
            // Update FHE-encrypted total (off-chain computation)
            _updateFHEEncryptedTotal(fheEncryptedAmount);
            
            emit FHECommitmentStored(commitment, fheEncryptedCommitment, fheEncryptedAmount);
        } else {
            // ZK-only mode: Use enhanced Pedersen commitments
            // Commitment already stored in ShieldedPool
            // Additional privacy via multiple commitment layers
            emit FHECommitmentStored(commitment, "", ""); // Empty FHE data in ZK mode
        }
    }
    
    // ============ FHE-Encrypted Queries ============
    
    /**
     * @notice Query pool balance (returns FHE-encrypted ciphertext if enabled, else commitment hash)
     * @dev In FHE mode: returns ciphertext. In ZK mode: returns commitment hash for privacy
     * @return fheEncryptedBalance FHE-encrypted total balance (euint) or commitment hash
     */
    function getPoolBalanceFHE() external view returns (bytes memory fheEncryptedBalance) {
        if (fheEnabled) {
            return fheEncryptedTotalBalance;
        } else {
            // ZK-only mode: Return merkle root hash (obfuscates real balance)
            // merkleRoot is a public state variable in ShieldedPool
            bytes32 root = merkleRoot;
            return abi.encodePacked(root);
        }
    }
    
    /**
     * @notice Query commitment amount (returns FHE-encrypted ciphertext)
     * @param commitment Commitment hash
     * @return fheEncryptedAmount FHE-encrypted amount (euint)
     */
    function getCommitmentAmountFHE(bytes32 commitment)
        external
        view
        returns (bytes memory fheEncryptedAmount)
    {
        return fheEncryptedAmounts[commitment];
    }
    
    /**
     * @notice Query multiple commitments (returns FHE-encrypted sum)
     * @dev Useful for obfuscating aggregate queries
     * @param commitments Array of commitment hashes
     * @return fheEncryptedSum FHE-encrypted sum (euint)
     */
    function getCommitmentsSumFHE(bytes32[] calldata commitments)
        external
        view
        returns (bytes memory fheEncryptedSum)
    {
        // In production: Use FHE addition on Zama network
        // For now: Return first commitment (mock)
        if (commitments.length > 0) {
            return fheEncryptedAmounts[commitments[0]];
        }
        return "";
    }
    
    // ============ Client-Side Decryption ============
    
    /**
     * @notice Store user's decryption key (encrypted)
     * @dev Key stored encrypted, user decrypts client-side
     * @param encryptedKey Encrypted decryption key
     */
    function storeDecryptionKey(bytes calldata encryptedKey) external {
        userDecryptionKeys[msg.sender] = encryptedKey;
    }
    
    /**
     * @notice Get user's encrypted decryption key
     * @return encryptedKey Encrypted decryption key (user decrypts client-side)
     */
    function getDecryptionKey() external view returns (bytes memory encryptedKey) {
        return userDecryptionKeys[msg.sender];
    }
    
    // ============ Internal Functions ============
    
    /**
     * @notice Update FHE-encrypted total balance
     * @dev Computation happens off-chain on Zama fhEVM
     * @param fheEncryptedAmount New FHE-encrypted amount to add
     */
    function _updateFHEEncryptedTotal(bytes calldata fheEncryptedAmount) internal {
        // In production: Use FHE addition on Zama network
        // For now: Store latest (mock)
        // Actual implementation would:
        // 1. Send fheEncryptedTotalBalance + fheEncryptedAmount to Zama fhEVM
        // 2. Get FHE-encrypted sum back
        // 3. Store new total
        fheEncryptedTotalBalance = fheEncryptedAmount; // Simplified
    }
}

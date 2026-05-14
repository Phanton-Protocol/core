// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./FHEEncryptedPool.sol";
import "./FHECoprocessor.sol";

/**
 * @title DynamicPoolFactory
 * @notice Creates and rotates sub-pools to obscure TVL/balance tracking
 * @dev Factory pattern with automatic rotation - makes aggregate analysis hard
 * 
 * Privacy Features:
 * - Creates 10+ child pool contracts
 * - Rotates active pools periodically
 * - FHE-encrypted queries across all pools
 * - Observers must manually sum (patterns break)
 * - Dynamic pool addresses (hard to track)
 */
contract DynamicPoolFactory {
    
    // ============ State Variables ============
    
    /// @notice Array of all created pools
    address[] public pools;
    
    /// @notice Currently active pools (for deposits)
    address[] public activePools;
    
    /// @notice Pool rotation interval (blocks)
    uint256 public constant ROTATION_INTERVAL = 1000; // ~5 minutes on BSC
    
    /// @notice Last rotation block
    uint256 public lastRotationBlock;

    /// @notice Rolling entropy for pool selection (updated on each pool creation / rotation).
    bytes32 private _rollingEntropy;
    
    /// @notice Number of active pools to maintain
    uint256 public constant ACTIVE_POOL_COUNT = 10;
    
    /// @notice FHE coprocessor for encrypted queries
    FHECoprocessor public immutable fheCoprocessor;
    
    /// @notice Core contracts (shared across pools)
    address public immutable verifier;
    address public immutable thresholdVerifier;
    address public immutable swapAdaptor;
    address public immutable feeOracle;
    address public immutable relayerRegistry;
    
    // ============ Events ============
    
    event PoolCreated(
        address indexed pool,
        uint256 poolIndex,
        uint256 timestamp
    );
    
    event PoolsRotated(
        address[] oldActivePools,
        address[] newActivePools,
        uint256 blockNumber
    );
    
    // ============ Constructor ============
    
    constructor(
        address _verifier,
        address _thresholdVerifier,
        address _swapAdaptor,
        address _feeOracle,
        address _relayerRegistry,
        address _fheCoprocessor
    ) {
        require(_verifier != address(0), "DynamicPoolFactory: zero verifier");
        require(_fheCoprocessor != address(0), "DynamicPoolFactory: zero coprocessor");
        
        verifier = _verifier;
        thresholdVerifier = _thresholdVerifier;
        swapAdaptor = _swapAdaptor;
        feeOracle = _feeOracle;
        relayerRegistry = _relayerRegistry;
        fheCoprocessor = FHECoprocessor(_fheCoprocessor);
        
        lastRotationBlock = block.number;
        _rollingEntropy = keccak256(abi.encodePacked(address(this), block.number, block.timestamp));
    }

    function _advanceEntropy(bytes32 contribution) internal {
        _rollingEntropy = keccak256(
            abi.encodePacked(_rollingEntropy, contribution, block.number, block.prevrandao)
        );
    }
    
    // ============ Public Functions ============
    
    /**
     * @notice Create a new FHE-encrypted pool
     * @return poolAddress Address of created pool
     */
    function createPool() external returns (address poolAddress) {
        return _createPoolInternal();
    }
    
    /**
     * @notice Create multiple pools at once
     * @param count Number of pools to create
     * @return poolAddresses Array of created pool addresses
     */
    function createPools(uint256 count) external returns (address[] memory poolAddresses) {
        require(count > 0 && count <= 20, "DynamicPoolFactory: invalid count");
        
        poolAddresses = new address[](count);
        
        for (uint256 i = 0; i < count; i++) {
            poolAddresses[i] = _createPoolInternal();
        }
        
        return poolAddresses;
    }
    
    /**
     * @notice Internal function to create a pool
     * @return poolAddress Address of created pool
     */
    function _createPoolInternal() internal returns (address poolAddress) {
        _advanceEntropy(bytes32(uint256(uint160(address(this)))));
        FHEEncryptedPool pool = new FHEEncryptedPool(
            verifier,
            thresholdVerifier,
            swapAdaptor,
            feeOracle,
            relayerRegistry,
            address(fheCoprocessor)
        );
        
        poolAddress = address(pool);
        pools.push(poolAddress);
        
        // Add to active pools if needed
        if (activePools.length < ACTIVE_POOL_COUNT) {
            activePools.push(poolAddress);
        }
        
        emit PoolCreated(poolAddress, pools.length - 1, block.timestamp);
        
        return poolAddress;
    }
    
    /**
     * @notice Rotate active pools (creates new, deactivates old)
     * @dev Called periodically to break tracking patterns
     */
    function rotatePools() external {
        require(
            block.number >= lastRotationBlock + ROTATION_INTERVAL,
            "DynamicPoolFactory: rotation too soon"
        );

        _advanceEntropy(bytes32(lastRotationBlock));

        address[] memory oldActivePools = activePools;
        
        // Create new pools
        address[] memory newPools = new address[](ACTIVE_POOL_COUNT);
        for (uint256 i = 0; i < ACTIVE_POOL_COUNT; i++) {
            newPools[i] = _createPoolInternal();
        }
        
        // Update active pools
        activePools = newPools;
        lastRotationBlock = block.number;
        
        emit PoolsRotated(oldActivePools, newPools, block.number);
    }
    
    /**
     * @notice Get random active pool for deposit
     * @dev Random selection makes tracking harder. Uses rolling entropy updated on pool creation/rotation.
     *      For high-value mainnet routing, prefer Chainlink VRF v2+ (https://docs.chain.link/vrf) over on-chain entropy.
     * @return poolAddress Random active pool address
     */
    function getRandomActivePool() external view returns (address poolAddress) {
        require(activePools.length > 0, "DynamicPoolFactory: no active pools");

        uint256 index = uint256(
            keccak256(abi.encodePacked(_rollingEntropy, block.number, msg.sender))
        ) % activePools.length;

        return activePools[index];
    }
    
    /**
     * @notice Get all active pools
     * @return pools Array of active pool addresses
     */
    function getActivePools() external view returns (address[] memory) {
        return activePools;
    }
    
    /**
     * @notice Get total pool count
     * @return count Total number of pools created
     */
    function getTotalPoolCount() external view returns (uint256 count) {
        return pools.length;
    }
    
    // ============ FHE-Encrypted Aggregate Queries ============
    
    /**
     * @notice Query total TVL across all pools (FHE-encrypted)
     * @dev Returns ciphertext - observers can't see real total
     * @return fheEncryptedTotal FHE-encrypted total balance (euint)
     */
    function getTotalTVLFHE() external pure returns (bytes memory fheEncryptedTotal) {
        // In production: Sum FHE-encrypted balances from all pools
        // For now: Return empty (mock)
        // Actual implementation:
        // 1. Query each pool's getPoolBalanceFHE()
        // 2. Sum FHE-encrypted values on Zama fhEVM network
        // 3. Return FHE-encrypted total
        return "";
    }
    
    /**
     * @notice Query TVL for specific pools (FHE-encrypted)
     * @return fheEncryptedSum FHE-encrypted sum (euint)
     */
    function getPoolsTVLFHE(address[] calldata /* poolAddresses */)
        external
        pure
        returns (bytes memory fheEncryptedSum)
    {
        // In production: Sum FHE-encrypted balances from specified pools
        // For now: Return empty (mock)
        return "";
    }
}

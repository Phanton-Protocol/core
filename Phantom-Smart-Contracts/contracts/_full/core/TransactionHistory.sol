// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TransactionHistory
 * @notice Manages platform-specific transaction keys and encrypted transaction history
 * @dev Users get platform-specific keys (separate from wallet keys) for tax reporting.
 *
 * Module 1 audit fix (High): the prior `setShieldedPool` permitted any caller
 * to claim the pool slot while `shieldedPool == address(0)` — a deploy-time
 * front-running window. The contract is now `Ownable`; only the owner may set
 * the pool, the slot is **one-shot** (cannot be repointed once non-zero), and
 * the binding is event-emitting.
 */
contract TransactionHistory is Ownable {
    // User address => platform transaction key
    mapping(address => bytes32) public userTransactionKeys;
    
    // Transaction key => user address (for lookup)
    mapping(bytes32 => address) public keyToUser;
    
    // User address => transaction count
    mapping(address => uint256) public transactionCount;
    
    // User address => transaction index => encrypted transaction data
    mapping(address => mapping(uint256 => bytes)) public encryptedTransactions;
    
    // User address => transaction index => transaction metadata (public)
    mapping(address => mapping(uint256 => TransactionMetadata)) public transactionMetadata;
    
    struct TransactionMetadata {
        uint256 timestamp;
        uint8 transactionType; // 0 = deposit, 1 = swap, 2 = withdrawal
        bytes32 commitment; // Note commitment
        bool isInternalMatch; // True if matched internally
    }
    
    event TransactionKeyGenerated(address indexed user, bytes32 indexed transactionKey);
    event TransactionLogged(
        address indexed user,
        uint256 indexed transactionIndex,
        uint8 transactionType,
        bytes32 commitment,
        bool isInternalMatch
    );
    
    /**
     * @notice Generate platform-specific transaction key for user
     * @dev Key is separate from wallet private key
     * @param user User address
     * @return transactionKey Platform-specific transaction key
     */
    function generateTransactionKey(address user) external returns (bytes32 transactionKey) {
        require(user != address(0), "TransactionHistory: zero address");
        require(userTransactionKeys[user] == bytes32(0), "TransactionHistory: key already exists");
        
        // Generate key: keccak256(user address + block.timestamp + blockhash)
        transactionKey = keccak256(abi.encodePacked(
            user,
            block.timestamp,
            blockhash(block.number - 1),
            block.prevrandao
        ));
        
        userTransactionKeys[user] = transactionKey;
        keyToUser[transactionKey] = user;
        
        emit TransactionKeyGenerated(user, transactionKey);
    }
    
    /**
     * @notice Get user's transaction key
     * @param user User address
     * @return transactionKey Platform-specific transaction key (bytes32(0) if not generated)
     */
    function getTransactionKey(address user) external view returns (bytes32 transactionKey) {
        return userTransactionKeys[user];
    }
    
    // Address that can log transactions (ShieldedPool)
    address public shieldedPool;
    
    modifier onlyShieldedPool() {
        require(msg.sender == shieldedPool, "TransactionHistory: unauthorized");
        _;
    }
    
    event ShieldedPoolSet(address indexed pool);

    constructor(address _shieldedPool) {
        // Allow zero address at deploy for two-step bootstrap; the owner
        // (deployer/multisig) must then call `setShieldedPool` exactly once.
        shieldedPool = _shieldedPool;
        if (_shieldedPool != address(0)) emit ShieldedPoolSet(_shieldedPool);
    }

    /**
     * @notice Set ShieldedPool address. One-shot, owner-only.
     * @dev Module 1 audit fix: previously front-runnable by any EOA while the
     *      slot was zero. Now `onlyOwner` and irreversible once set non-zero,
     *      eliminating the squatting window.
     */
    function setShieldedPool(address _shieldedPool) external onlyOwner {
        require(_shieldedPool != address(0), "TransactionHistory: zero address");
        require(shieldedPool == address(0), "TransactionHistory: already set");
        shieldedPool = _shieldedPool;
        emit ShieldedPoolSet(_shieldedPool);
    }
    
    function logTransaction(
        address user,
        uint8 transactionType,
        bytes32 commitment,
        bytes calldata encryptedData,
        bool isInternalMatch
    ) external onlyShieldedPool {
        
        uint256 index = transactionCount[user];
        
        encryptedTransactions[user][index] = encryptedData;
        transactionMetadata[user][index] = TransactionMetadata({
            timestamp: block.timestamp,
            transactionType: transactionType,
            commitment: commitment,
            isInternalMatch: isInternalMatch
        });
        
        transactionCount[user]++;
        
        emit TransactionLogged(user, index, transactionType, commitment, isInternalMatch);
    }
    
    /**
     * @notice Get transaction count for user
     * @param user User address
     * @return count Number of transactions
     */
    function getTransactionCount(address user) external view returns (uint256 count) {
        return transactionCount[user];
    }
    
    /**
     * @notice Get transaction metadata (public info)
     * @param user User address
     * @param index Transaction index
     * @return metadata Transaction metadata
     */
    function getTransactionMetadata(
        address user,
        uint256 index
    ) external view returns (TransactionMetadata memory metadata) {
        return transactionMetadata[user][index];
    }
    
    /**
     * @notice Get encrypted transaction data
     * @param user User address
     * @param index Transaction index
     * @return encryptedData Encrypted transaction data (user must decrypt with their key)
     */
    function getEncryptedTransaction(
        address user,
        uint256 index
    ) external view returns (bytes memory encryptedData) {
        return encryptedTransactions[user][index];
    }
}

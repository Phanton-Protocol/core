// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "../interfaces/IShieldedPool.sol";

/**
 * @title MatchingHandler
 * @notice External contract to handle internal matching logic and reduce main contract size
 * @dev **NON-PRODUCTION / EXPERIMENTAL** — not Path-B. Handles FHE-based order matching.
 *      Security: Only ShieldedPool can call this contract's functions
 */
contract MatchingHandler {
    /// @notice Max open orders per asset-pair side (DoS guard on matching loops).
    uint256 public constant MAX_ORDER_BOOK_SIZE = 256;

    IShieldedPool public immutable shieldedPool;
    address public fheCoprocessor;
    
    struct SwapOrder {
        bytes32 inputCommitment;
        bytes32 outputCommitment;
        uint256 inputAssetID;
        uint256 outputAssetID;
        bytes32 nullifier;
        bytes32 merkleRoot;
        uint256 timestamp;
        bool matched;
        bytes32 matchHash;
        // FHE-encrypted fields for private matching
        bytes fheEncryptedInputAmount;    // FHE-encrypted input amount
        bytes fheEncryptedMinOutput;      // FHE-encrypted minimum output
        bytes32 fheExecutionId;           // FHE computation execution ID
    }
    
    mapping(bytes32 => SwapOrder) public pendingOrders;
    mapping(bytes32 => bytes32[]) public buyOrders;
    mapping(bytes32 => bytes32[]) public sellOrders;
    mapping(bytes32 => bytes32) public matchedSwaps;
    mapping(bytes32 => bool) public executedMatches;
    
    event SwapOrderSubmitted(bytes32 indexed orderHash, uint256 inputAssetID, uint256 outputAssetID);
    event OrdersMatched(bytes32 indexed matchHash, bytes32 indexed orderHash1, bytes32 indexed orderHash2);
    event InternalSwapExecuted(bytes32 indexed matchHash);
    
    modifier onlyShieldedPool() {
        require(msg.sender == address(shieldedPool), "MatchingHandler: only ShieldedPool");
        _;
    }
    
    constructor(address _shieldedPool) {
        shieldedPool = IShieldedPool(_shieldedPool);
    }
    
    function setFHECoprocessor(address _fheCoprocessor) external onlyShieldedPool {
        fheCoprocessor = _fheCoprocessor;
    }
    
    /**
     * @notice Create and store swap order
     */
    function createOrder(
        bytes32 orderHash,
        bytes32 inputCommitment,
        bytes32 outputCommitment,
        uint256 inputAssetID,
        uint256 outputAssetID,
        bytes32 nullifier,
        bytes32 merkleRoot
    ) external onlyShieldedPool {
        pendingOrders[orderHash] = SwapOrder({
            inputCommitment: inputCommitment,
            outputCommitment: outputCommitment,
            inputAssetID: inputAssetID,
            outputAssetID: outputAssetID,
            nullifier: nullifier,
            merkleRoot: merkleRoot,
            timestamp: block.timestamp,
            matched: false,
            matchHash: bytes32(0),
            fheEncryptedInputAmount: "",
            fheEncryptedMinOutput: "",
            fheExecutionId: bytes32(0)
        });
    }
    
    /**
     * @notice Create order with FHE-encrypted amounts
     */
    function createOrderFHE(
        bytes32 orderHash,
        bytes32 inputCommitment,
        bytes32 outputCommitment,
        uint256 inputAssetID,
        uint256 outputAssetID,
        bytes32 nullifier,
        bytes32 merkleRoot,
        bytes calldata fheEncryptedInputAmount,
        bytes calldata fheEncryptedMinOutput
    ) external onlyShieldedPool {
        pendingOrders[orderHash] = SwapOrder({
            inputCommitment: inputCommitment,
            outputCommitment: outputCommitment,
            inputAssetID: inputAssetID,
            outputAssetID: outputAssetID,
            nullifier: nullifier,
            merkleRoot: merkleRoot,
            timestamp: block.timestamp,
            matched: false,
            matchHash: bytes32(0),
            fheEncryptedInputAmount: fheEncryptedInputAmount,
            fheEncryptedMinOutput: fheEncryptedMinOutput,
            fheExecutionId: bytes32(0)
        });
    }
    
    /**
     * @notice Try to match order (basic - checks asset IDs only)
     */
    function tryMatchOrder(bytes32 orderHash) external onlyShieldedPool returns (bytes32 matchHash) {
        SwapOrder storage order = pendingOrders[orderHash];
        require(!order.matched, "MatchingHandler: order already matched");
        
        bytes32 reversePairHash = keccak256(abi.encodePacked(
            order.outputAssetID,
            order.inputAssetID
        ));
        
        bytes32[] storage potentialMatches = buyOrders[reversePairHash];
        
        for (uint256 i = 0; i < potentialMatches.length; i++) {
            bytes32 candidateHash = potentialMatches[i];
            SwapOrder storage candidate = pendingOrders[candidateHash];
            
            if (!candidate.matched && candidate.timestamp <= order.timestamp + 1 hours) {
                // Basic matching: only check asset IDs (no amount verification)
                if (candidate.inputAssetID == order.outputAssetID && 
                    candidate.outputAssetID == order.inputAssetID) {
                    matchHash = keccak256(abi.encodePacked(orderHash, candidateHash, block.timestamp));
                    matchedSwaps[matchHash] = orderHash;
                    matchedSwaps[keccak256(abi.encodePacked(matchHash))] = candidateHash;
                    
                    order.matched = true;
                    order.matchHash = matchHash;
                    candidate.matched = true;
                    candidate.matchHash = matchHash;
                    
                    emit OrdersMatched(matchHash, orderHash, candidateHash);
                    return matchHash;
                }
            }
        }
        
        bytes32 assetPairHash = keccak256(abi.encodePacked(
            order.inputAssetID,
            order.outputAssetID
        ));
        require(buyOrders[assetPairHash].length < MAX_ORDER_BOOK_SIZE, "MatchingHandler: order book full");
        buyOrders[assetPairHash].push(orderHash);
        
        emit SwapOrderSubmitted(orderHash, order.inputAssetID, order.outputAssetID);
        return bytes32(0);
    }
    
    /**
     * @notice Try to match order using FHE-encrypted amounts
     * @dev Uses FHE coprocessor to match encrypted amounts without revealing them
     */
    function tryMatchOrderFHE(bytes32 orderHash) external onlyShieldedPool returns (bytes32 matchHash) {
        SwapOrder storage order = pendingOrders[orderHash];
        require(!order.matched, "MatchingHandler: order already matched");
        require(order.fheEncryptedInputAmount.length > 0, "MatchingHandler: no FHE data");
        require(fheCoprocessor != address(0), "MatchingHandler: FHE coprocessor not set");
        
        bytes32 reversePairHash = keccak256(abi.encodePacked(
            order.outputAssetID,
            order.inputAssetID
        ));
        
        bytes32[] storage potentialMatches = buyOrders[reversePairHash];
        
        for (uint256 i = 0; i < potentialMatches.length; i++) {
            bytes32 candidateHash = potentialMatches[i];
            SwapOrder storage candidate = pendingOrders[candidateHash];
            
            if (!candidate.matched && 
                candidate.timestamp <= order.timestamp + 1 hours &&
                candidate.fheEncryptedInputAmount.length > 0) {
                
                // Check asset IDs match
                if (candidate.inputAssetID == order.outputAssetID && 
                    candidate.outputAssetID == order.inputAssetID) {
                    
                    // Request FHE computation to match encrypted amounts
                    bytes32 fheExecutionId = keccak256(abi.encodePacked(
                        orderHash,
                        candidateHash,
                        block.timestamp
                    ));
                    
                    // Call FHE coprocessor to match encrypted amounts
                    // This will trigger off-chain FHE computation
                    (bool success, ) = fheCoprocessor.call(
                        abi.encodeWithSignature(
                            "requestFHEComputation(bytes32,uint256)",
                            keccak256(abi.encodePacked(
                                order.fheEncryptedInputAmount,
                                candidate.fheEncryptedInputAmount,
                                order.fheEncryptedMinOutput,
                                candidate.fheEncryptedMinOutput
                            )),
                            0
                        )
                    );
                    
                    if (success) {
                        // Store FHE execution ID
                        order.fheExecutionId = fheExecutionId;
                        candidate.fheExecutionId = fheExecutionId;
                        
                        // Create match (amount verification happens off-chain via FHE)
                        matchHash = keccak256(abi.encodePacked(orderHash, candidateHash, block.timestamp));
                        matchedSwaps[matchHash] = orderHash;
                        matchedSwaps[keccak256(abi.encodePacked(matchHash))] = candidateHash;
                        
                        order.matched = true;
                        order.matchHash = matchHash;
                        candidate.matched = true;
                        candidate.matchHash = matchHash;
                        
                        emit OrdersMatched(matchHash, orderHash, candidateHash);
                        return matchHash;
                    }
                }
            }
        }
        
        // No match found, store order
        bytes32 assetPairHash = keccak256(abi.encodePacked(
            order.inputAssetID,
            order.outputAssetID
        ));
        require(buyOrders[assetPairHash].length < MAX_ORDER_BOOK_SIZE, "MatchingHandler: order book full");
        buyOrders[assetPairHash].push(orderHash);
        
        emit SwapOrderSubmitted(orderHash, order.inputAssetID, order.outputAssetID);
        return bytes32(0);
    }
    
    /**
     * @notice Execute internal match
     */
    function executeInternalMatch(bytes32 matchHash) external onlyShieldedPool returns (bool) {
        require(!executedMatches[matchHash], "MatchingHandler: match already executed");
        require(matchedSwaps[matchHash] != bytes32(0), "MatchingHandler: invalid match");
        
        executedMatches[matchHash] = true;
        emit InternalSwapExecuted(matchHash);
        return true;
    }
    
    function isMatchExecuted(bytes32 matchHash) external view returns (bool) {
        return executedMatches[matchHash];
    }
    
    function getOrder(bytes32 orderHash) external view returns (
        bytes32 inputCommitment,
        bytes32 outputCommitment,
        uint256 inputAssetID,
        uint256 outputAssetID,
        bool matched,
        bytes32 matchHash
    ) {
        SwapOrder storage order = pendingOrders[orderHash];
        return (
            order.inputCommitment,
            order.outputCommitment,
            order.inputAssetID,
            order.outputAssetID,
            order.matched,
            order.matchHash
        );
    }
}

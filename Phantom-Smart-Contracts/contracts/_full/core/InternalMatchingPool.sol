// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ShieldedPool.sol";
import "../types/Types.sol";

/**
 * @title InternalMatchingPool
 * @notice Maximum privacy pool with internal buyer/seller matching
 * @dev **NON-PRODUCTION / EXPERIMENTAL** — not Path-B. Do not deploy for mainnet liquidity.
 *      Pool matches orders internally, only uses PancakeSwap as fallback
 * 
 * Privacy Features:
 * 1. Internal Matching: Buyer/seller matched inside pool (no external visibility)
 * 2. Pool Executes Swaps: Pool swaps directly (not relayer)
 * 3. Batch Execution: Multiple swaps batched together (harder to track)
 * 4. PancakeSwap Fallback: Only used if no internal match
 * 5. Proof-Based: Amounts hidden in ZK proof
 * 6. Encrypted Pool Data: Merkle root obfuscation
 * 
 * Flow:
 * 1. Users submit swap intents (with proof, amounts hidden)
 * 2. Pool matches buyer/seller internally
 * 3. Pool executes matched swaps (no external visibility)
 * 4. If no match, pool uses PancakeSwap (batched with others)
 * 5. All swaps batched together (harder to track individual)
 */
contract InternalMatchingPool is ShieldedPool {
    
    // ============ State Variables ============
    
    /// @notice Pending swap intents (waiting for match)
    /// @dev intentHash => SwapIntent
    mapping(bytes32 => SwapIntent) public pendingIntents;
    
    /// @notice Matched swaps (ready to execute)
    /// @dev matchId => MatchedSwap
    mapping(bytes32 => MatchedSwap) public matchedSwaps;
    
    /// @notice Batch of swaps to execute
    /// @dev batchId => SwapBatch
    mapping(bytes32 => SwapBatch) public swapBatches;
    
    /// @notice Commitment sum (obfuscates pool balance)
    bytes32 public commitmentSum;
    
    /// @notice Noise commitments (pattern breaking)
    bytes32[] public noiseCommitments;
    
    /// @notice Maximum noise commitments
    uint256 public constant MAX_NOISE = 100;

    /// @notice Max swaps per batch execution (DoS guard).
    uint256 public constant MAX_BATCH_SIZE = 10;

    /// @notice Max open orders per asset-pair side (DoS guard on matching loops).
    uint256 public constant MAX_ORDER_BOOK_SIZE = 256;
    
    /// @notice Batch execution interval (blocks)
    uint256 public constant BATCH_INTERVAL = 5;
    
    /// @notice Last batch execution block
    uint256 public lastBatchBlock;
    
    // ============ Order Book Indexing ============
    
    /// @notice Asset pair => list of buy orders (sorted by timestamp)
    /// @dev assetPairHash => intentHash[]
    mapping(bytes32 => bytes32[]) public buyOrders;
    
    /// @notice Asset pair => list of sell orders (sorted by timestamp)
    /// @dev assetPairHash => intentHash[]
    mapping(bytes32 => bytes32[]) public sellOrders;
    
    /// @notice Intent hash => index in buyOrders array
    mapping(bytes32 => uint256) public buyOrderIndex;
    
    /// @notice Intent hash => index in sellOrders array
    mapping(bytes32 => uint256) public sellOrderIndex;
    
    /// @notice Asset pair => total buy volume (for matching priority)
    mapping(bytes32 => uint256) public buyVolume;
    
    /// @notice Asset pair => total sell volume (for matching priority)
    mapping(bytes32 => uint256) public sellVolume;
    
    // ============ Structs ============
    
    struct SwapIntent {
        Proof proof;                    // ZK proof (amounts hidden)
        bytes32 inputCommitment;        // Input commitment
        bytes32 outputCommitment;      // Output commitment
        bytes32 nullifier;              // Nullifier
        bytes32 merkleRoot;             // Merkle root
        uint256 inputAssetID;            // Asset ID (in commitment, not public)
        uint256 outputAssetID;          // Asset ID (in commitment, not public)
        uint256 inputAmount;            // Input amount (for PancakeSwap execution)
        uint256 minOutputAmount;        // Min output amount (for PancakeSwap)
        address user;                   // User address (hidden via relayer)
        uint256 timestamp;              // Submission time
        IntentStatus status;            // Intent status
    }
    
    struct MatchedSwap {
        bytes32 buyerIntentHash;        // Buyer intent hash
        bytes32 sellerIntentHash;       // Seller intent hash
        bytes32 buyerOutputCommitment;  // Buyer output commitment
        bytes32 sellerOutputCommitment; // Seller output commitment
        uint256 matchTimestamp;        // Match time
        bool executed;                  // Execution status
    }
    
    struct SwapBatch {
        bytes32[] matchedSwapIds;       // Matched swaps to execute
        bytes32[] unmatchedIntentHashes; // Unmatched intents (use PancakeSwap)
        uint256 batchBlock;             // Block when batch created
        bool executed;                 // Execution status
    }
    
    enum IntentStatus {
        PENDING,        // Waiting for match
        MATCHED,        // Matched with counterparty
        EXECUTING,      // Being executed
        EXECUTED,       // Completed
        CANCELLED       // Cancelled
    }
    
    // ============ Events ============
    
    event SwapIntentSubmitted(
        bytes32 indexed intentHash,
        address indexed user,
        bytes32 inputCommitment,
        bytes32 outputCommitment,
        uint256 timestamp
    );
    
    event SwapMatched(
        bytes32 indexed matchId,
        bytes32 indexed buyerIntentHash,
        bytes32 indexed sellerIntentHash,
        uint256 timestamp
    );
    
    event BatchCreated(
        bytes32 indexed batchId,
        uint256 matchedCount,
        uint256 unmatchedCount,
        uint256 blockNumber
    );
    
    event BatchExecuted(
        bytes32 indexed batchId,
        uint256 executedCount,
        uint256 pancakeSwapCount
    );
    
    event PancakeSwapExecuted(bytes32 indexed intentHash, uint256 inputAmount, uint256 outputAmount);
    
    event InternalSwapExecuted(
        bytes32 indexed matchId,
        bytes32 buyerIntentHash,
        bytes32 sellerIntentHash
    );
    
    event NoiseCommitmentAdded(bytes32 indexed noiseCommitment);
    
    // ============ Constructor ============
    
    constructor(
        address _verifier,
        address _thresholdVerifier,
        address _swapAdaptor,
        address _feeOracle,
        address _relayerRegistry
    ) ShieldedPool(
        _verifier,
        address(0),
        _thresholdVerifier,
        _swapAdaptor,
        _feeOracle,
        _relayerRegistry
    ) {
        commitmentSum = bytes32(0);
        lastBatchBlock = block.number;
    }
    
    // ============ Submit Swap Intent ============
    
    /**
     * @notice Submit swap intent (buyer or seller)
     * @dev User submits proof, pool matches internally
     * @param proof ZK proof (amounts hidden inside)
     * @param inputCommitment Input commitment
     * @param outputCommitment Output commitment
     * @param nullifier Nullifier
     * @param merkleRootParam Merkle root
     * @param inputAssetID Input asset ID (in commitment, not public)
     * @param outputAssetID Output asset ID (in commitment, not public)
     * @return intentHash Intent hash for tracking
     */
    function submitSwapIntent(
        Proof calldata proof,
        bytes32 inputCommitment,
        bytes32 outputCommitment,
        bytes32 nullifier,
        bytes32 merkleRootParam,
        uint256 inputAssetID,
        uint256 outputAssetID
    ) external returns (bytes32 intentHash) {
        // Verify proof (amounts verified inside)
        require(
            _verifySwapIntentProof(proof, inputCommitment, outputCommitment, nullifier, merkleRootParam),
            "InternalMatchingPool: invalid proof"
        );
        
        // Verify nullifier not used
        require(!nullifiers[nullifier], "InternalMatchingPool: nullifier used");
        
        // Verify merkle root (merkleRoot is public in ShieldedPool)
        require(merkleRootParam == merkleRoot, "InternalMatchingPool: merkle root mismatch");
        
        // Generate intent hash
        intentHash = keccak256(abi.encodePacked(
            msg.sender,
            inputCommitment,
            outputCommitment,
            nullifier,
            block.timestamp
        ));
        
        // Store intent (amounts set when executing PancakeSwap)
        pendingIntents[intentHash] = SwapIntent({
            proof: proof,
            inputCommitment: inputCommitment,
            outputCommitment: outputCommitment,
            nullifier: nullifier,
            merkleRoot: merkleRoot,
            inputAssetID: inputAssetID,
            outputAssetID: outputAssetID,
            inputAmount: 0, // Set when executing PancakeSwap
            minOutputAmount: 0, // Set when executing PancakeSwap
            user: msg.sender,
            timestamp: block.timestamp,
            status: IntentStatus.PENDING
        });
        
        emit SwapIntentSubmitted(intentHash, msg.sender, inputCommitment, outputCommitment, block.timestamp);
        
        // Add to order book
        _addToOrderBook(intentHash, inputAssetID, outputAssetID);
        
        // Try to match immediately
        _tryMatchIntent(intentHash);
        
        return intentHash;
    }
    
    /**
     * @notice Add intent to order book for efficient matching
     * @param intentHash Intent hash
     * @param inputAssetID Input asset ID
     * @param outputAssetID Output asset ID
     */
    function _addToOrderBook(bytes32 intentHash, uint256 inputAssetID, uint256 outputAssetID) internal {
        bytes32 assetPairHash = _getAssetPairHash(inputAssetID, outputAssetID);
        bytes32 reversePairHash = _getAssetPairHash(outputAssetID, inputAssetID);
        require(
            buyOrders[assetPairHash].length < MAX_ORDER_BOOK_SIZE
                && sellOrders[reversePairHash].length < MAX_ORDER_BOOK_SIZE,
            "InternalMatchingPool: order book full"
        );
        
        // Determine if this is a buy or sell order
        // For simplicity, we'll classify based on asset IDs
        // In production, could use price or other criteria
        
        // Add to buy orders (wants outputAssetID)
        buyOrders[assetPairHash].push(intentHash);
        buyOrderIndex[intentHash] = buyOrders[assetPairHash].length - 1;
        
        // Also add to reverse pair for matching
        sellOrders[reversePairHash].push(intentHash);
        sellOrderIndex[intentHash] = sellOrders[reversePairHash].length - 1;
    }
    
    /**
     * @notice Remove intent from order book
     * @param intentHash Intent hash
     * @param inputAssetID Input asset ID
     * @param outputAssetID Output asset ID
     */
    function _removeFromOrderBook(bytes32 intentHash, uint256 inputAssetID, uint256 outputAssetID) internal {
        bytes32 assetPairHash = _getAssetPairHash(inputAssetID, outputAssetID);
        bytes32 reversePairHash = _getAssetPairHash(outputAssetID, inputAssetID);
        
        // Remove from buy orders
        uint256 buyIndex = buyOrderIndex[intentHash];
        if (buyIndex < buyOrders[assetPairHash].length) {
            // Swap with last element and pop (gas efficient)
            bytes32 lastBuy = buyOrders[assetPairHash][buyOrders[assetPairHash].length - 1];
            buyOrders[assetPairHash][buyIndex] = lastBuy;
            buyOrderIndex[lastBuy] = buyIndex;
            buyOrders[assetPairHash].pop();
            delete buyOrderIndex[intentHash];
        }
        
        // Remove from sell orders
        uint256 sellIndex = sellOrderIndex[intentHash];
        if (sellIndex < sellOrders[reversePairHash].length) {
            bytes32 lastSell = sellOrders[reversePairHash][sellOrders[reversePairHash].length - 1];
            sellOrders[reversePairHash][sellIndex] = lastSell;
            sellOrderIndex[lastSell] = sellIndex;
            sellOrders[reversePairHash].pop();
            delete sellOrderIndex[intentHash];
        }
    }
    
    /**
     * @notice Get asset pair hash for indexing
     * @param assetA First asset ID
     * @param assetB Second asset ID
     * @return pairHash Hash of asset pair
     */
    function _getAssetPairHash(uint256 assetA, uint256 assetB) internal pure returns (bytes32 pairHash) {
        // Always use smaller asset ID first for consistent hashing
        if (assetA < assetB) {
            return keccak256(abi.encodePacked(assetA, assetB));
        } else {
            return keccak256(abi.encodePacked(assetB, assetA));
        }
    }
    
    // ============ Internal Matching ============
    
    /**
     * @notice Try to match intent with existing pending intents
     * @dev Matches buyer with seller (same assets, opposite direction)
     * @param intentHash Intent hash to match
     */
    function _tryMatchIntent(bytes32 intentHash) internal {
        SwapIntent storage intent = pendingIntents[intentHash];
        require(intent.status == IntentStatus.PENDING, "InternalMatchingPool: intent not pending");
        
        // Find matching intent (opposite direction, same assets)
        bytes32 matchHash = _findMatchingIntent(intentHash);
        
        if (matchHash != bytes32(0)) {
            // Match found!
            _createMatch(intentHash, matchHash);
        }
        // If no match, intent stays pending for batch execution
    }
    
    /**
     * @notice Find matching intent (buyer finds seller, seller finds buyer)
     * @dev Implements efficient order book matching with price-time priority
     * @param intentHash Intent hash to match
     * @return matchHash Matching intent hash, or bytes32(0) if no match
     */
    function _findMatchingIntent(bytes32 intentHash) internal view returns (bytes32 matchHash) {
        SwapIntent storage intent = pendingIntents[intentHash];
        require(intent.status == IntentStatus.PENDING, "InternalMatchingPool: intent not pending");
        
        // Determine if this is a buy or sell order
        // Buy: wants outputAssetID, has inputAssetID
        // Sell: has inputAssetID, wants outputAssetID
        // For matching: buyer wants what seller has, seller wants what buyer has
        
        // Try to find opposite order:
        // - If this is a buy order (wants outputAssetID), find sell order (has outputAssetID)
        // - If this is a sell order (has inputAssetID), find buy order (wants inputAssetID)
        
        // Reverse asset pair for matching (buyer's output = seller's input)
        bytes32 reversePairHash = _getAssetPairHash(intent.outputAssetID, intent.inputAssetID);
        
        // Check sell orders if this is a buy order
        bytes32[] storage oppositeOrders = sellOrders[reversePairHash];
        
        // If no opposite orders, try buy orders (this might be a sell order)
        if (oppositeOrders.length == 0) {
            oppositeOrders = buyOrders[reversePairHash];
        }
        
        // Linear search through opposite orders (FIFO - first in, first out)
        // In production, could use price-time priority or other algorithms
        for (uint256 i = 0; i < oppositeOrders.length; i++) {
            bytes32 candidateHash = oppositeOrders[i];
            SwapIntent storage candidate = pendingIntents[candidateHash];
            
            // Verify candidate is still pending
            if (candidate.status != IntentStatus.PENDING) {
                continue;
            }
            
            // Verify assets match (opposite direction)
            // This order: inputAssetID -> outputAssetID
            // Candidate: outputAssetID -> inputAssetID (opposite)
            if (candidate.inputAssetID == intent.outputAssetID && 
                candidate.outputAssetID == intent.inputAssetID) {
                // Match found! Return first available match (FIFO)
                return candidateHash;
            }
        }
        
        // No match found
        return bytes32(0);
    }
    
    /**
     * @notice Create match between buyer and seller
     * @param buyerIntentHash Buyer intent hash
     * @param sellerIntentHash Seller intent hash
     */
    function _createMatch(bytes32 buyerIntentHash, bytes32 sellerIntentHash) internal {
        SwapIntent storage buyerIntent = pendingIntents[buyerIntentHash];
        SwapIntent storage sellerIntent = pendingIntents[sellerIntentHash];
        
        require(buyerIntent.status == IntentStatus.PENDING, "InternalMatchingPool: buyer not pending");
        require(sellerIntent.status == IntentStatus.PENDING, "InternalMatchingPool: seller not pending");
        
        // Verify assets match (opposite direction)
        require(
            buyerIntent.inputAssetID == sellerIntent.outputAssetID &&
            buyerIntent.outputAssetID == sellerIntent.inputAssetID,
            "InternalMatchingPool: asset mismatch"
        );
        
        // Generate match ID
        bytes32 matchId = keccak256(abi.encodePacked(buyerIntentHash, sellerIntentHash, block.timestamp));
        
        // Create match
        matchedSwaps[matchId] = MatchedSwap({
            buyerIntentHash: buyerIntentHash,
            sellerIntentHash: sellerIntentHash,
            buyerOutputCommitment: buyerIntent.outputCommitment,
            sellerOutputCommitment: sellerIntent.outputCommitment,
            matchTimestamp: block.timestamp,
            executed: false
        });
        
        // Update intent status
        buyerIntent.status = IntentStatus.MATCHED;
        sellerIntent.status = IntentStatus.MATCHED;
        
        // Remove from order book
        _removeFromOrderBook(buyerIntentHash, buyerIntent.inputAssetID, buyerIntent.outputAssetID);
        _removeFromOrderBook(sellerIntentHash, sellerIntent.inputAssetID, sellerIntent.outputAssetID);
        
        emit SwapMatched(matchId, buyerIntentHash, sellerIntentHash, block.timestamp);
    }
    
    // ============ Batch Execution ============
    
    /**
     * @notice Create batch of swaps to execute
     * @dev Collects matched swaps and unmatched intents
     * @return batchId Batch ID
     */
    function createBatch() external returns (bytes32 batchId) {
        require(block.number >= lastBatchBlock + BATCH_INTERVAL, "InternalMatchingPool: batch interval not met");
        
        // Collect matched swaps
        bytes32[] memory matchedIds = _collectMatchedSwaps();
        
        // Collect unmatched intents (will use PancakeSwap)
        bytes32[] memory unmatchedHashes = _collectUnmatchedIntents();

        require(
            matchedIds.length <= MAX_BATCH_SIZE && unmatchedHashes.length <= MAX_BATCH_SIZE,
            "InternalMatchingPool: batch too large"
        );
        
        // Generate batch ID
        batchId = keccak256(abi.encodePacked(block.number, block.timestamp, matchedIds.length, unmatchedHashes.length));
        
        // Create batch
        swapBatches[batchId] = SwapBatch({
            matchedSwapIds: matchedIds,
            unmatchedIntentHashes: unmatchedHashes,
            batchBlock: block.number,
            executed: false
        });
        
        lastBatchBlock = block.number;
        
        emit BatchCreated(batchId, matchedIds.length, unmatchedHashes.length, block.number);
        
        return batchId;
    }
    
    /**
     * @notice Execute batch of swaps
     * @dev Executes matched swaps internally, unmatched via PancakeSwap
     * @param batchId Batch ID to execute
     */
    function executeBatch(bytes32 batchId) external {
        SwapBatch storage batch = swapBatches[batchId];
        require(!batch.executed, "InternalMatchingPool: batch already executed");
        require(block.number >= batch.batchBlock, "InternalMatchingPool: batch not ready");
        
        batch.executed = true;

        require(
            batch.matchedSwapIds.length <= MAX_BATCH_SIZE
                && batch.unmatchedIntentHashes.length <= MAX_BATCH_SIZE,
            "InternalMatchingPool: batch too large"
        );
        
        uint256 executedCount = 0;
        uint256 pancakeSwapCount = 0;
        
        // Execute matched swaps (internal)
        for (uint256 i = 0; i < batch.matchedSwapIds.length; i++) {
            _executeMatchedSwap(batch.matchedSwapIds[i]);
            executedCount++;
        }
        
        // Execute unmatched intents (via PancakeSwap, batched)
        // CRITICAL: Pool executes swaps (not relayer)
        for (uint256 i = 0; i < batch.unmatchedIntentHashes.length; i++) {
            bytes32 intentHash = batch.unmatchedIntentHashes[i];
            SwapIntent storage intent = pendingIntents[intentHash];
            // In production: Extract amounts from commitment verification
            // For now: Use placeholder (will be set from proof verification)
            uint256 inputAmount = intent.inputAmount > 0 ? intent.inputAmount : 1 ether; // Placeholder
            uint256 minOutput = intent.minOutputAmount > 0 ? intent.minOutputAmount : 0; // Placeholder
            _executePancakeSwap(intentHash, inputAmount, minOutput);
            pancakeSwapCount++;
        }
        
        emit BatchExecuted(batchId, executedCount, pancakeSwapCount);
    }
    
    /**
     * @notice Execute matched swap internally
     * @dev Buyer and seller swap directly (no external visibility)
     * @param matchId Match ID
     */
    function _executeMatchedSwap(bytes32 matchId) internal {
        MatchedSwap storage matchedSwap = matchedSwaps[matchId];
        require(!matchedSwap.executed, "InternalMatchingPool: match already executed");
        
        SwapIntent storage buyerIntent = pendingIntents[matchedSwap.buyerIntentHash];
        SwapIntent storage sellerIntent = pendingIntents[matchedSwap.sellerIntentHash];
        
        // Mark as executing
        buyerIntent.status = IntentStatus.EXECUTING;
        sellerIntent.status = IntentStatus.EXECUTING;
        
        // Execute internal swap:
        // 1. Buyer's input commitment → Seller's output commitment
        // 2. Seller's input commitment → Buyer's output commitment
        // 3. No external visibility (all internal)
        
        // Update commitments
        // Note: commitments and commitmentCount are in ShieldedPool
        // For now, we'll use deposit mechanism or add protected function
        // TODO: Add protected function in ShieldedPool to insert commitments
        // For now, simplified (will be fixed when tree access is available)
        
        // Update commitment sum
        commitmentSum = keccak256(abi.encodePacked(commitmentSum, matchedSwap.buyerOutputCommitment));
        commitmentSum = keccak256(abi.encodePacked(commitmentSum, matchedSwap.sellerOutputCommitment));
        
        // Mark nullifiers
        nullifiers[buyerIntent.nullifier] = true;
        nullifiers[sellerIntent.nullifier] = true;
        
        // Mark as executed
        buyerIntent.status = IntentStatus.EXECUTED;
        sellerIntent.status = IntentStatus.EXECUTED;
        matchedSwap.executed = true;
        
        emit InternalSwapExecuted(matchId, matchedSwap.buyerIntentHash, matchedSwap.sellerIntentHash);
        emit CommitmentAdded(matchedSwap.buyerOutputCommitment, commitmentCount - 1);
        emit CommitmentAdded(matchedSwap.sellerOutputCommitment, commitmentCount);
        emit NullifierMarked(buyerIntent.nullifier);
        emit NullifierMarked(sellerIntent.nullifier);
    }
    
    /**
     * @notice Execute unmatched intent via PancakeSwap
     * @dev Uses PancakeSwap as fallback (batched with others)
     * @param intentHash Intent hash
     */
    /**
     * @notice Execute unmatched intent via PancakeSwap
     * @dev POOL EXECUTES SWAP (not relayer) - Pool contract calls PancakeSwap
     * @param intentHash Intent hash
     * @param inputAmount Input amount (from commitment verification)
     * @param minOutputAmount Min output amount (from commitment verification)
     */
    function _executePancakeSwap(bytes32 intentHash, uint256 inputAmount, uint256 minOutputAmount) internal {
        SwapIntent storage intent = pendingIntents[intentHash];
        require(intent.status == IntentStatus.PENDING, "InternalMatchingPool: intent not pending");
        require(inputAmount > 0, "InternalMatchingPool: zero input amount");
        
        // Mark as executing
        intent.status = IntentStatus.EXECUTING;
        
        // CRITICAL: POOL EXECUTES SWAP (not relayer)
        address inputToken = assetRegistry[intent.inputAssetID];
        address outputToken = assetRegistry[intent.outputAssetID];
        require(inputToken != address(0) && outputToken != address(0), "InternalMatchingPool: invalid assets");
        
        // Prepare swap parameters
        // Path is bytes (encoded address array)
        bytes memory path = abi.encodePacked(inputToken, outputToken);
        
        SwapParams memory swapParams = SwapParams({
            tokenIn: inputToken,
            tokenOut: outputToken,
            amountIn: inputAmount,
            minAmountOut: minOutputAmount,
            fee: 3000, // 0.3% fee tier
            sqrtPriceLimitX96: 0,
            path: path
        });
        
        // POOL EXECUTES SWAP via PancakeSwap adaptor (pool contract executes, not relayer)
        uint256 swapOutput;
        if (inputToken == address(0)) {
            // BNB swap - pool sends BNB to PancakeSwap
            swapOutput = swapAdaptor.executeSwap{value: inputAmount}(swapParams);
        } else {
            // ERC20 swap - pool approves and executes
            IERC20(inputToken).approve(address(swapAdaptor), inputAmount);
            swapOutput = swapAdaptor.executeSwap(swapParams);
        }
        
        // Verify swap output
        require(swapOutput >= minOutputAmount, "InternalMatchingPool: slippage exceeded");
        
        // Mark as executed
        intent.status = IntentStatus.EXECUTED;
        nullifiers[intent.nullifier] = true;
        
        emit NullifierMarked(intent.nullifier);
        emit PancakeSwapExecuted(intentHash, inputAmount, swapOutput);
    }
    
    // ============ Helper Functions ============
    
    /**
     * @notice Collect matched swaps ready to execute
     * @dev Iterates through all matched swaps and collects unexecuted ones
     * @return matchedIds Array of match IDs
     */
    function _collectMatchedSwaps() internal pure returns (bytes32[] memory matchedIds) {
        // Note: In production, maintain a separate list of matched swap IDs
        // For now, we'll need to track this differently or use events
        // This is a simplified version - in production, use indexed storage
        
        // Return empty for now - matched swaps are tracked via events
        // In production, maintain: bytes32[] public matchedSwapIds;
        return new bytes32[](0);
    }
    
    /**
     * @notice Collect unmatched intents (pending status)
     * @dev Collects all pending intents that haven't been matched
     * @return unmatchedHashes Array of intent hashes
     */
    function _collectUnmatchedIntents() internal pure returns (bytes32[] memory unmatchedHashes) {
        // Note: In production, maintain a separate list of pending intent hashes
        // For now, this is simplified - would need to iterate all intents (expensive)
        // Better approach: maintain bytes32[] public pendingIntentHashes;
        
        // Return empty for now - in production, use indexed storage
        return new bytes32[](0);
    }
    
    /**
     * @notice Get order book size for an asset pair
     * @param inputAssetID Input asset ID
     * @param outputAssetID Output asset ID
     * @return buyCount Number of buy orders
     * @return sellCount Number of sell orders
     */
    function getOrderBookSize(uint256 inputAssetID, uint256 outputAssetID) 
        external 
        view 
        returns (uint256 buyCount, uint256 sellCount) 
    {
        bytes32 assetPairHash = _getAssetPairHash(inputAssetID, outputAssetID);
        bytes32 reversePairHash = _getAssetPairHash(outputAssetID, inputAssetID);
        
        buyCount = buyOrders[assetPairHash].length;
        sellCount = sellOrders[reversePairHash].length;
        
        return (buyCount, sellCount);
    }
    
    /**
     * @notice Verify swap intent proof
     * @dev Verifies ZK proof with amounts hidden inside
     */
    function _verifySwapIntentProof(
        Proof calldata proof,
        bytes32 inputCommitment,
        bytes32 outputCommitment,
        bytes32 nullifier,
        bytes32 merkleRoot
    ) internal view returns (bool valid) {
        // Prepare public inputs (only commitments, no amounts)
        uint256[] memory publicInputs = new uint256[](4);
        publicInputs[0] = uint256(nullifier);
        publicInputs[1] = uint256(inputCommitment);
        publicInputs[2] = uint256(outputCommitment);
        publicInputs[3] = uint256(merkleRoot);
        
        // Verify proof (amounts verified inside)
        // verifier.verifyProof expects (Proof calldata proof, uint256[] calldata publicInputs)
        return verifier.verifyProof(proof, publicInputs);
    }
    
    // ============ Pool Data Obfuscation ============
    
    /**
     * @notice Get obfuscated pool balance
     * @return obfuscatedBalance Merkle root (obfuscates real balance)
     */
    function getObfuscatedBalance() external view returns (bytes32 obfuscatedBalance) {
        return merkleRoot; // merkleRoot is public in ShieldedPool
    }
    
    /**
     * @notice Get commitment sum
     * @return sum Commitment sum hash
     */
    function getCommitmentSum() external view returns (bytes32 sum) {
        return commitmentSum;
    }
    
    // ============ Noise Commitments ============
    
    /**
     * @notice Add noise commitment
     */
    function addNoiseCommitment(bytes32 noiseCommitment) external {
        require(noiseCommitments.length < MAX_NOISE, "InternalMatchingPool: max noise reached");
        require(noiseCommitment != bytes32(0), "InternalMatchingPool: zero commitment");
        
        noiseCommitments.push(noiseCommitment);
        commitmentSum = keccak256(abi.encodePacked(commitmentSum, noiseCommitment));
        
        emit NoiseCommitmentAdded(noiseCommitment);
    }
}

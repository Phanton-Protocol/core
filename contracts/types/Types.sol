// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Types
 * @notice Core data structures for the Shadow-DeFi Protocol
 * @dev UTXO-based privacy mixer with multi-asset support
 */

/**
 * @notice Represents a shielded note (stored off-chain)
 * @dev The commitment H(AssetID, Amount, BlindingFactor, OwnerPublicKey) is stored on-chain
 */
struct Note {
    uint256 assetID;        // 0 = BNB, 1 = USDT, 2 = CAKE, etc.
    uint256 amount;         // Amount in asset's native units (wei, 6 decimals, etc.)
    uint256 blindingFactor; // Random 256-bit value for privacy
    bytes32 ownerPublicKey; // Owner's public key (can be derived from address or separate key)
}

/**
 * @notice ZK-SNARK proof structure (Groth16 or Plonk)
 * @dev Proof data is passed as bytes and verified by the verifier contract
 */
struct Proof {
    bytes a;      // G1 point (Groth16) or proof elements (Plonk)
    bytes b;      // G2 point (Groth16) or proof elements (Plonk)
    bytes c;      // G1 point (Groth16) or proof elements (Plonk)
}

/**
 * @notice Public inputs for the ZK circuit verification (Legacy - single output)
 * @dev These values are revealed on-chain and must match the proof
 * @dev NOTE: Use JoinSplitPublicInputs for join-split transactions
 */
struct PublicInputs {
    bytes32 nullifier;           // Hash of spent note (prevents double-spending)
    bytes32 inputCommitment;     // Commitment of the note being spent
    bytes32 outputCommitment;    // Commitment of the new note being created
    bytes32 merkleRoot;          // Current Merkle root of the state tree
    uint256 inputAssetID;        // Asset ID of the input note
    uint256 outputAssetID;       // Asset ID of the output note
    uint256 inputAmount;         // Amount being spent (for circuit verification)
    uint256 outputAmount;        // Amount being received (must match PancakeSwap output)
    uint256 minOutputAmount;     // Minimum acceptable output (slippage protection)
    uint256 gasRefund;           // Gas refund amount for relayer
    uint256 protocolFee;         // Protocol fee amount
    uint256[10] merklePath;      // Merkle path for input commitment (up to 10 levels)
    uint256[10] merklePathIndices; // Indices for Merkle path
}

/**
 * @notice Public inputs for Join-Split transactions (1 input, 2 outputs)
 * @dev Enables partial swaps and withdrawals with change notes
 * 
 * Conservation Rule: Input_Amount = Swap_Amount + Change_Amount + Protocol_Fee + Gas_Refund
 * 
 * Example: 10 BNB input → Swap 4 BNB to USDT + Keep 6 BNB as change
 * - inputAmount: 10 BNB
 * - swapAmount: 4 BNB (sent to PancakeSwap)
 * - changeAmount: 6 BNB (stays in pool as new note)
 * - protocolFee + gasRefund: deducted from input
 */
struct JoinSplitPublicInputs {
    bytes32 nullifier;              // Hash of spent note (prevents double-spending)
    bytes32 inputCommitment;        // Commitment of the note being spent
    bytes32 outputCommitmentSwap;    // Commitment of the swap output note (e.g., USDT)
    bytes32 outputCommitmentChange; // Commitment of the change note (e.g., remaining BNB)
    bytes32 merkleRoot;             // Current Merkle root of the state tree
    uint256 inputAssetID;           // Asset ID of the input note
    uint256 outputAssetIDSwap;      // Asset ID of the swap output note
    uint256 outputAssetIDChange;    // Asset ID of the change note (usually same as input)
    uint256 inputAmount;            // Total amount being spent
    uint256 swapAmount;             // Amount being swapped (sent to PancakeSwap)
    uint256 changeAmount;           // Amount kept as change (stays in pool)
    uint256 outputAmountSwap;       // Amount received from swap (must match PancakeSwap output)
    uint256 minOutputAmountSwap;   // Minimum acceptable swap output (slippage protection)
    uint256 gasRefund;              // Gas refund amount for relayer
    uint256 protocolFee;            // Protocol fee amount
    uint256[10] merklePath;         // Merkle path for input commitment (up to 10 levels)
    uint256[10] merklePathIndices;  // Indices for Merkle path
}

/**
 * @notice Parameters for executing a swap via PancakeSwap
 */
struct SwapParams {
    address tokenIn;          // Input token address (0x0 for BNB)
    address tokenOut;         // Output token address
    uint256 amountIn;         // Exact input amount
    uint256 minAmountOut;     // Minimum output amount (slippage protection)
    uint24 fee;               // PancakeSwap V3 pool fee tier (500, 3000, 10000)
    uint160 sqrtPriceLimitX96; // Price limit for swap (0 = no limit)
    bytes path;               // Swap path for multi-hop swaps
}

/**
 * @notice Transaction metadata for shielded swap (Legacy - single output)
 * @dev NOTE: Use JoinSplitSwapData for join-split swaps
 */
struct ShieldedSwapData {
    Proof proof;              // ZK-SNARK proof
    PublicInputs publicInputs; // Public inputs for verification
    SwapParams swapParams;    // PancakeSwap swap parameters
    address relayer;          // Address of the relayer executing the transaction
}

/**
 * @notice Transaction metadata for join-split shielded swap
 * @dev Supports partial swaps with change notes
 */
struct JoinSplitSwapData {
    Proof proof;                      // ZK-SNARK proof (Join-Split circuit)
    JoinSplitPublicInputs publicInputs; // Public inputs for verification
    SwapParams swapParams;            // PancakeSwap swap parameters
    address relayer;                  // Address of the relayer executing the transaction
    bytes encryptedPayload;           // Optional encrypted payload for user-only visibility
}

/**
 * @notice Transaction metadata for shielded withdrawal
 * @dev Supports partial withdrawals with change notes
 */
struct ShieldedWithdrawData {
    Proof proof;                      // ZK-SNARK proof (Join-Split circuit)
    JoinSplitPublicInputs publicInputs; // Public inputs (outputCommitmentSwap = zero for withdrawal)
    address recipient;                // External address to receive withdrawn funds
    address relayer;                  // Address of the relayer executing the transaction
    bytes encryptedPayload;           // Optional encrypted payload for user-only visibility
}

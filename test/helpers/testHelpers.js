/**
 * @title Test Helpers
 * @notice Utility functions for testing Shadow-DeFi Protocol
 */

const { ethers } = require("hardhat");

/**
 * Generate a random commitment hash
 */
function generateCommitment(seed = Math.random().toString()) {
    return ethers.keccak256(ethers.toUtf8Bytes(seed));
}

/**
 * Generate a nullifier from commitment and owner key
 */
function generateNullifier(commitment, ownerPublicKey) {
    return ethers.keccak256(
        ethers.solidityPacked(["bytes32", "bytes32"], [commitment, ownerPublicKey])
    );
}

/**
 * Create mock proof data
 */
function createMockProof() {
    return {
        a: ethers.toUtf8Bytes("proof_a"),
        b: ethers.toUtf8Bytes("proof_b"),
        c: ethers.toUtf8Bytes("proof_c")
    };
}

/**
 * Create join-split public inputs for swap
 */
function createJoinSplitSwapInputs({
    inputCommitment,
    outputCommitmentSwap,
    outputCommitmentChange,
    merkleRoot,
    inputAssetID,
    outputAssetIDSwap,
    outputAssetIDChange,
    inputAmount,
    swapAmount,
    changeAmount,
    outputAmountSwap,
    minOutputAmountSwap,
    protocolFee,
    gasRefund,
    ownerPublicKey
}) {
    const nullifier = generateNullifier(inputCommitment, ownerPublicKey);
    
    return {
        nullifier: nullifier,
        inputCommitment: inputCommitment,
        outputCommitmentSwap: outputCommitmentSwap,
        outputCommitmentChange: outputCommitmentChange,
        merkleRoot: merkleRoot,
        inputAssetID: inputAssetID,
        outputAssetIDSwap: outputAssetIDSwap,
        outputAssetIDChange: outputAssetIDChange,
        inputAmount: inputAmount,
        swapAmount: swapAmount,
        changeAmount: changeAmount,
        outputAmountSwap: outputAmountSwap,
        minOutputAmountSwap: minOutputAmountSwap,
        gasRefund: gasRefund,
        protocolFee: protocolFee,
        merklePath: Array(10).fill(0),
        merklePathIndices: Array(10).fill(0)
    };
}

/**
 * Create join-split public inputs for withdrawal
 */
function createJoinSplitWithdrawInputs({
    inputCommitment,
    outputCommitmentChange,
    merkleRoot,
    inputAssetID,
    inputAmount,
    withdrawAmount,
    changeAmount,
    protocolFee,
    gasRefund,
    ownerPublicKey
}) {
    const nullifier = generateNullifier(inputCommitment, ownerPublicKey);
    
    return {
        nullifier: nullifier,
        inputCommitment: inputCommitment,
        outputCommitmentSwap: ethers.ZeroHash, // Zero for withdrawal
        outputCommitmentChange: outputCommitmentChange,
        merkleRoot: merkleRoot,
        inputAssetID: inputAssetID,
        outputAssetIDSwap: 0, // Zero for withdrawal
        outputAssetIDChange: inputAssetID, // Change is same asset as input
        inputAmount: inputAmount,
        swapAmount: withdrawAmount, // Repurposed as withdraw amount
        changeAmount: changeAmount,
        outputAmountSwap: 0, // Zero for withdrawal
        minOutputAmountSwap: 0,
        gasRefund: gasRefund,
        protocolFee: protocolFee,
        merklePath: Array(10).fill(0),
        merklePathIndices: Array(10).fill(0)
    };
}

/**
 * Verify amount conservation
 */
function verifyAmountConservation(inputAmount, swapAmount, changeAmount, protocolFee, gasRefund) {
    const totalOutput = swapAmount + changeAmount + protocolFee + gasRefund;
    return inputAmount === totalOutput;
}

/**
 * Create swap parameters
 */
function createSwapParams({
    tokenIn,
    tokenOut,
    amountIn,
    minAmountOut,
    fee = 3000,
    sqrtPriceLimitX96 = 0,
    path = "0x"
}) {
    return {
        tokenIn: tokenIn,
        tokenOut: tokenOut,
        amountIn: amountIn,
        minAmountOut: minAmountOut,
        fee: fee,
        sqrtPriceLimitX96: sqrtPriceLimitX96,
        path: path
    };
}

module.exports = {
    generateCommitment,
    generateNullifier,
    createMockProof,
    createJoinSplitSwapInputs,
    createJoinSplitWithdrawInputs,
    verifyAmountConservation,
    createSwapParams
};

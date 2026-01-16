pragma circom 2.1.0;

// ============================================================================
// Join-Split Circuit for Shadow-DeFi Protocol
// ============================================================================
// This circuit verifies a join-split transaction:
// - 1 Input Note → 2 Output Notes (Swap Result + Change)
// - Enforces amount conservation: Input = Swap + Change + Fees
// ============================================================================

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/mimc.circom";

template JoinSplit() {
    // ============ PRIVATE INPUTS ============
    // Input Note
    signal input inputAssetID;
    signal input inputAmount;
    signal input inputBlindingFactor;
    signal input ownerPublicKey;
    
    // Output Note 1 (Swap Result)
    signal input outputAssetIDSwap;
    signal input outputAmountSwap;
    signal input swapBlindingFactor;
    
    // Output Note 2 (Change)
    signal input outputAssetIDChange;
    signal input changeAmount;
    signal input changeBlindingFactor;
    
    // Swap Parameters
    signal input swapAmount;  // Amount being swapped
    
    // ============ PUBLIC INPUTS ============
    signal input nullifier;
    signal input inputCommitment;
    signal input outputCommitmentSwap;
    signal input outputCommitmentChange;
    signal input merkleRoot;
    signal input outputAmountSwapPublic;  // Expected swap output (from PancakeSwap)
    signal input minOutputAmountSwap;     // Slippage protection
    signal input protocolFee;
    signal input gasRefund;
    
    // Merkle Proof
    signal input merklePath[10];
    signal input merklePathIndices[10];
    
    // ============ INTERMEDIATE SIGNALS ============
    // Component for Pedersen Hash (using Poseidon as Pedersen replacement)
    component poseidon2 = Poseidon(2);
    component inputPoseidon = Poseidon(4);
    component swapPoseidon = Poseidon(4);
    
    // Comparators
    
    // ============ CONSTRAINT 1: INPUT COMMITMENT VALIDATION ============
    // inputCommitment = H(inputAssetID, inputAmount, inputBlindingFactor, ownerPublicKey)
    inputPoseidon.inputs[0] <== inputAssetID;
    inputPoseidon.inputs[1] <== inputAmount;
    inputPoseidon.inputs[2] <== inputBlindingFactor;
    inputPoseidon.inputs[3] <== ownerPublicKey;
    
    inputCommitment === inputPoseidon.out;
    
    // ============ CONSTRAINT 2: NULLIFIER GENERATION ============
    // nullifier = H(inputCommitment, ownerPublicKey)
    poseidon2.inputs[0] <== inputCommitment;
    poseidon2.inputs[1] <== ownerPublicKey;
    
    nullifier === poseidon2.out;
    
    // ============ CONSTRAINT 3: OUTPUT COMMITMENT SWAP ============
    // outputCommitmentSwap = H(outputAssetIDSwap, outputAmountSwap, swapBlindingFactor, ownerPublicKey)
    // Note: If outputCommitmentSwap == 0, this is a withdrawal (skip swap commitment)
    component swapCommitmentCheck = IsEqual();
    swapCommitmentCheck.in[0] <== outputCommitmentSwap;
    swapCommitmentCheck.in[1] <== 0;
    
    // Only compute swap commitment if not zero (not a withdrawal)
    swapPoseidon.inputs[0] <== outputAssetIDSwap;
    swapPoseidon.inputs[1] <== outputAmountSwap;
    swapPoseidon.inputs[2] <== swapBlindingFactor;
    swapPoseidon.inputs[3] <== ownerPublicKey;
    
    // If outputCommitmentSwap != 0, it must match computed commitment
    // This is a simplified check - full implementation needs conditional logic
    (1 - swapCommitmentCheck.out) * (outputCommitmentSwap - swapPoseidon.out) === 0;
    
    // ============ CONSTRAINT 4: OUTPUT COMMITMENT CHANGE ============
    // outputCommitmentChange = H(outputAssetIDChange, changeAmount, changeBlindingFactor, ownerPublicKey)
    component changePoseidon = Poseidon(4);
    changePoseidon.inputs[0] <== outputAssetIDChange;
    changePoseidon.inputs[1] <== changeAmount;
    changePoseidon.inputs[2] <== changeBlindingFactor;
    changePoseidon.inputs[3] <== ownerPublicKey;
    
    outputCommitmentChange === changePoseidon.out;
    
    // ============ CONSTRAINT 5: AMOUNT CONSERVATION ============
    // inputAmount = swapAmount + changeAmount + protocolFee + gasRefund
    signal totalOutput;
    totalOutput <== swapAmount + changeAmount + protocolFee + gasRefund;
    
    inputAmount === totalOutput;
    
    // ============ CONSTRAINT 6: SWAP OUTPUT VERIFICATION ============
    // outputAmountSwapPublic >= minOutputAmountSwap (slippage protection)
    // Only check if this is a swap (outputCommitmentSwap != 0)
    component slippageCheck = GreaterThan(252);
    slippageCheck.in[0] <== outputAmountSwapPublic;
    slippageCheck.in[1] <== minOutputAmountSwap;
    
    // If swap commitment is non-zero, enforce slippage protection
    (1 - swapCommitmentCheck.out) * (1 - slippageCheck.out) === 0;
    
    // ============ CONSTRAINT 7: SWAP AMOUNT VALIDATION ============
    // swapAmount > 0 (must swap something)
    component swapAmountCheck = GreaterThan(252);
    swapAmountCheck.in[0] <== swapAmount;
    swapAmountCheck.in[1] <== 0;
    swapAmountCheck.out === 1;
    
    // ============ CONSTRAINT 8: CHANGE AMOUNT VALIDATION ============
    // changeAmount > 0 (must have change for join-split)
    component changeAmountCheck = GreaterThan(252);
    changeAmountCheck.in[0] <== changeAmount;
    changeAmountCheck.in[1] <== 0;
    changeAmountCheck.out === 1;
    
    // ============ CONSTRAINT 9: CHANGE ASSET VALIDATION ============
    // outputAssetIDChange == inputAssetID (change is same asset as input)
    outputAssetIDChange === inputAssetID;
    
    // ============ CONSTRAINT 10: MERKLE PROOF VERIFICATION ============
    // Full Merkle path verification using MiMC7 hash (matches on-chain MiMC tree)
    component merkleHash[10];
    signal cur[11];
    signal left[10];
    signal right[10];
    signal leftDiff[10];
    signal rightDiff[10];
    cur[0] <== inputCommitment;
    for (var i = 0; i < 10; i++) {
        // enforce index is 0/1
        merklePathIndices[i] * (merklePathIndices[i] - 1) === 0;
        // left = cur + idx * (path - cur)
        leftDiff[i] <== merklePath[i] - cur[i];
        left[i] <== cur[i] + merklePathIndices[i] * leftDiff[i];

        // right = path + idx * (cur - path)
        rightDiff[i] <== cur[i] - merklePath[i];
        right[i] <== merklePath[i] + merklePathIndices[i] * rightDiff[i];
        merkleHash[i] = MiMC7(91);
        merkleHash[i].x_in <== left[i];
        merkleHash[i].k <== right[i];
        cur[i + 1] <== merkleHash[i].out;
    }
    merkleRoot === cur[10];
    
    // ============ CONSTRAINT 11: OUTPUT AMOUNT MATCH ============
    // outputAmountSwapPublic === outputAmountSwap (swap output matches expected)
    // Only if this is a swap (outputCommitmentSwap != 0)
    (1 - swapCommitmentCheck.out) * (outputAmountSwapPublic - outputAmountSwap) === 0;
}

component main { public [
    nullifier,
    inputCommitment,
    outputCommitmentSwap,
    outputCommitmentChange,
    merkleRoot,
    outputAmountSwapPublic,
    minOutputAmountSwap,
    protocolFee,
    gasRefund,
    merklePath,
    merklePathIndices
] } = JoinSplit();

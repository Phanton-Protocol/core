pragma circom 2.0.0;

include "mimc7.circom";
include "bitify.circom";
include "comparators.circom";

/**
 * Join-split Groth16 (10 public outputs, order fixed for JoinSplitVerifier.sol):
 *   0 nullifier
 *   1 inputCommitment
 *   2 outputCommitmentSwap
 *   3 outputCommitmentChange
 *   4 merkleRoot
 *   5 outputAmountSwap
 *   6 minOutputAmountSwap
 *   7 protocolFee
 *   8 gasRefund
 *   9 routingCommitment
 *
 * Private witness matches phantom-relayer-dashboard/backend/src/noteModel.js:
 *   commitment = MiMC7(MiMC7(MiMC7(assetID, amount), blinding), ownerPublicKey)
 *   nullifier  = MiMC7(commitment, ownerPublicKey)
 *
 * Merkle path matches on-chain MerkleTree.verifyProof (MiMC7, depth 10).
 *
 * withdrawMode: 1 iff swap leg is unused (withdraw-style: outputCommitmentSwap == 0 on-chain).
 *   swap_leaf = (1 - withdrawMode) * mimcSwapCommit
 *
 * Amounts are range-checked to 120 bits so conservation uses integer addition in Fr
 * without modular wrap (sum < field prime).
 */
template JoinSplitPublic9() {
    // ---- public outputs (Groth16 public signals, indices 0..8) ----
    signal output nullifier;
    signal output inputCommitment;
    signal output outputCommitmentSwap;
    signal output outputCommitmentChange;
    signal output merkleRoot;
    signal output outputAmountSwap;
    signal output minOutputAmountSwap;
    signal output protocolFee;
    signal output gasRefund;
    signal output routingCommitment;

    // ---- private witness: spent input note ----
    signal input inputAssetID;
    signal input inputAmount;
    signal input inputBlindingFactor;
    signal input ownerPublicKey;

    // ---- private: swap output note (witness unused when withdrawMode = 1) ----
    signal input outputAssetIDSwap;
    signal input outputAmountSwapNote;
    signal input swapBlindingFactor;

    // ---- private: change output note ----
    signal input outputAssetIDChange;
    signal input changeAmount;
    signal input changeBlindingFactor;

    // ---- private: split ----
    signal input swapAmount;

    // 1 = withdraw-style (no swap note); 0 = join-split swap
    signal input withdrawMode;

    // ---- Merkle ----
    signal input merklePath[10];
    signal input merklePathIndices[10];

    // Witness mirrors of public fee/slippage fields (range-checked, assigned to outputs)
    signal input protocolFeeWitness;
    signal input gasRefundWitness;
    signal input minOutputAmountSwapWitness;

    withdrawMode * (1 - withdrawMode) === 0;

    component rcInAmt = Num2Bits(120);
    rcInAmt.in <== inputAmount;
    component rcSwapAmt = Num2Bits(120);
    rcSwapAmt.in <== swapAmount;
    component rcChange = Num2Bits(120);
    rcChange.in <== changeAmount;
    component rcProto = Num2Bits(120);
    rcProto.in <== protocolFeeWitness;
    component rcGas = Num2Bits(120);
    rcGas.in <== gasRefundWitness;
    component rcOutSwapNote = Num2Bits(120);
    rcOutSwapNote.in <== outputAmountSwapNote;
    component rcMinOut = Num2Bits(120);
    rcMinOut.in <== minOutputAmountSwapWitness;

    // ---- input commitment + nullifier (noteModel.js) ----
    component mIn1 = MiMC7();
    mIn1.x <== inputAssetID;
    mIn1.k <== inputAmount;
    component mIn2 = MiMC7();
    mIn2.x <== mIn1.h;
    mIn2.k <== inputBlindingFactor;
    component mIn3 = MiMC7();
    mIn3.x <== mIn2.h;
    mIn3.k <== ownerPublicKey;
    inputCommitment <== mIn3.h;

    component mNul = MiMC7();
    mNul.x <== inputCommitment;
    mNul.k <== ownerPublicKey;
    nullifier <== mNul.h;

    // ---- swap output commitment ----
    component mS1 = MiMC7();
    mS1.x <== outputAssetIDSwap;
    mS1.k <== outputAmountSwapNote;
    component mS2 = MiMC7();
    mS2.x <== mS1.h;
    mS2.k <== swapBlindingFactor;
    component mS3 = MiMC7();
    mS3.x <== mS2.h;
    mS3.k <== ownerPublicKey;
    signal mimcSwapCommit;
    mimcSwapCommit <== mS3.h;

    signal swap_leaf;
    swap_leaf <== (1 - withdrawMode) * mimcSwapCommit;
    outputCommitmentSwap <== swap_leaf;

    // ---- change commitment ----
    component mC1 = MiMC7();
    mC1.x <== outputAssetIDChange;
    mC1.k <== changeAmount;
    component mC2 = MiMC7();
    mC2.x <== mC1.h;
    mC2.k <== changeBlindingFactor;
    component mC3 = MiMC7();
    mC3.x <== mC2.h;
    mC3.k <== ownerPublicKey;
    outputCommitmentChange <== mC3.h;

    // ---- Merkle inclusion (Solidity MerkleTree.verifyProof) ----
    signal level[11];
    signal merkleLeft[10];
    signal merkleRight[10];
    level[0] <== inputCommitment;
    component mM[10];
    for (var i = 0; i < 10; i++) {
        merklePathIndices[i] * (1 - merklePathIndices[i]) === 0;
        // left/right as linear interpolation (idx binary) — avoids non-quadratic forms in some circom versions
        merkleLeft[i] <== level[i] + merklePathIndices[i] * (merklePath[i] - level[i]);
        merkleRight[i] <== merklePath[i] + merklePathIndices[i] * (level[i] - merklePath[i]);
        mM[i] = MiMC7();
        mM[i].x <== merkleLeft[i];
        mM[i].k <== merkleRight[i];
        level[i + 1] <== mM[i].h;
    }
    merkleRoot <== level[10];

    // ---- conservation ----
    inputAmount === swapAmount + changeAmount + protocolFeeWitness + gasRefundWitness;

    withdrawMode * outputAmountSwapNote === 0;
    withdrawMode * minOutputAmountSwapWitness === 0;

    // ---- slippage when swap leg active ----
    component slip = LessEqThan(120);
    slip.in[0] <== minOutputAmountSwapWitness;
    slip.in[1] <== outputAmountSwapNote;
    (1 - withdrawMode) * (1 - slip.out) === 0;

    protocolFee <== protocolFeeWitness;
    gasRefund <== gasRefundWitness;
    outputAmountSwap <== outputAmountSwapNote;
    minOutputAmountSwap <== minOutputAmountSwapWitness;

    // Routing commitment binds private asset/amount routing metadata into a single public signal.
    // This lets relayer/validator authorization key off one commitment instead of clear fields.
    component r0 = MiMC7();
    r0.x <== inputAssetID;
    r0.k <== outputAssetIDSwap;
    component r1 = MiMC7();
    r1.x <== r0.h;
    r1.k <== outputAssetIDChange;
    component r2 = MiMC7();
    r2.x <== r1.h;
    r2.k <== inputAmount;
    component r3 = MiMC7();
    r3.x <== r2.h;
    r3.k <== swapAmount;
    component r4 = MiMC7();
    r4.x <== r3.h;
    r4.k <== changeAmount;
    component r5 = MiMC7();
    r5.x <== r4.h;
    r5.k <== outputAmountSwapNote;
    component r6 = MiMC7();
    r6.x <== r5.h;
    r6.k <== minOutputAmountSwapWitness;
    component r7 = MiMC7();
    r7.x <== r6.h;
    r7.k <== protocolFeeWitness;
    component r8 = MiMC7();
    r8.x <== r7.h;
    r8.k <== gasRefundWitness;
    component r9 = MiMC7();
    r9.x <== r8.h;
    r9.k <== withdrawMode;
    routingCommitment <== r9.h;
}

component main = JoinSplitPublic9();

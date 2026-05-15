// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "../types/Types.sol";
import "./MiMC7.sol";
import "./ProtocolFeeMath.sol";

/**
 * @title JoinSplitPublicInputValidation
 * @notice Calldata checks + verifier calldata packing for join-split (M3a). Linked to reduce pool bytecode.
 * @dev Align with `SwapHandler.processJoinSplitSwap` / `WithdrawHandler` / `withdrawValidate.js` (non-fee; M3b fees).
 *      Revert codes: `cvs` conservation, `gRf` gas refund bound, `zSw`/`zCh` zero legs, `wCm`/`wAs`/`wAm` withdraw swap fields,
 *      `zWd` zero withdraw leg. Pool DEX binding: `SP:slp` slippage, `SP:out` exact output vs public `outputAmountSwap`.
 */
library JoinSplitPublicInputValidation {
    uint256 private constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    function merklePathToBytes32(uint256[10] memory arr) internal pure returns (bytes32[10] memory result) {
        // Safe: loop bound 10; index cannot overflow uint256.
        unchecked {
            for (uint256 i = 0; i < 10; ++i) {
                result[i] = bytes32(arr[i]);
            }
        }
    }

    /// @dev Order matches `JoinSplitVerifier` / circuit public signals.
    function joinSplitInputsToArray(JoinSplitPublicInputs memory inputs) internal pure returns (uint256[] memory arr) {
        uint256 withdrawMode = inputs.outputCommitmentSwap == bytes32(0) ? 1 : 0;
        uint256 r0 = MiMC7.mimc7(inputs.inputAssetID, inputs.outputAssetIDSwap);
        uint256 r1 = MiMC7.mimc7(r0, inputs.outputAssetIDChange);
        uint256 r2 = MiMC7.mimc7(r1, inputs.inputAmount);
        uint256 r3 = MiMC7.mimc7(r2, inputs.swapAmount);
        uint256 r4 = MiMC7.mimc7(r3, inputs.changeAmount);
        uint256 r5 = MiMC7.mimc7(r4, inputs.outputAmountSwap);
        uint256 r6 = MiMC7.mimc7(r5, inputs.minOutputAmountSwap);
        uint256 r7 = MiMC7.mimc7(r6, inputs.protocolFee);
        uint256 r8 = MiMC7.mimc7(r7, inputs.gasRefund);

        arr = new uint256[](10);
        arr[0] = uint256(inputs.nullifier) % SNARK_SCALAR_FIELD;
        arr[1] = uint256(inputs.inputCommitment) % SNARK_SCALAR_FIELD;
        arr[2] = uint256(inputs.outputCommitmentSwap) % SNARK_SCALAR_FIELD;
        arr[3] = uint256(inputs.outputCommitmentChange) % SNARK_SCALAR_FIELD;
        arr[4] = uint256(inputs.merkleRoot) % SNARK_SCALAR_FIELD;
        arr[5] = inputs.outputAmountSwap % SNARK_SCALAR_FIELD;
        arr[6] = inputs.minOutputAmountSwap % SNARK_SCALAR_FIELD;
        arr[7] = inputs.protocolFee % SNARK_SCALAR_FIELD;
        arr[8] = inputs.gasRefund % SNARK_SCALAR_FIELD;
        arr[9] = MiMC7.mimc7(r8, withdrawMode) % SNARK_SCALAR_FIELD;
    }

    function requireCalldataConservation(JoinSplitPublicInputs memory inputs) internal pure {
        require(
            inputs.inputAmount == inputs.swapAmount + inputs.changeAmount + inputs.protocolFee + inputs.gasRefund,
            "SP:cvs"
        );
        ProtocolFeeMath.requireGasRefundBounded(inputs.gasRefund, inputs.inputAmount);
    }

    function requireDexJoinSplitShape(JoinSplitPublicInputs memory inputs) internal pure {
        requireCalldataConservation(inputs);
        require(inputs.swapAmount > 0, "SP:zSw");
        require(inputs.changeAmount > 0, "SP:zCh");
    }

    function requireWithdrawJoinSplitShape(JoinSplitPublicInputs memory inputs) internal pure {
        requireCalldataConservation(inputs);
        require(inputs.outputCommitmentSwap == bytes32(0), "SP:wCm");
        require(inputs.outputAssetIDSwap == 0, "SP:wAs");
        require(inputs.outputAmountSwap == 0 && inputs.minOutputAmountSwap == 0, "SP:wAm");
        require(inputs.swapAmount > 0, "SP:zWd");
        require(inputs.changeAmount > 0, "SP:zCh");
    }
}

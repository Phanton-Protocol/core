// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "../interfaces/IFeeOracle.sol";
import "./ProtocolFeeMath.sol";

/**
 * @title JoinSplitFeeValidation
 * @notice External join-split fee gate (oracle + 10 bps DEX). Linked library shrinks pool bytecode.
 */
library JoinSplitFeeValidation {
    /// @return totalProtocolFee Canonical fee; reverts {ProtocolFeeMath.ProtocolFeeMismatch} if `supplied` differs.
    function validateAndReturnJoinSplitFee(
        IFeeOracle feeOracle,
        address inputToken,
        uint256 inputAmount,
        uint256 suppliedProtocolFee
    ) external view returns (uint256 totalProtocolFee) {
        totalProtocolFee = ProtocolFeeMath.joinSplitTotalProtocolFee(
            feeOracle.calculateFee(inputToken, inputAmount),
            inputAmount
        );
        ProtocolFeeMath.requireExactProtocolFee(suppliedProtocolFee, totalProtocolFee);
    }
}

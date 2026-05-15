// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "../libraries/ProtocolFeeMath.sol";

/// @notice Hardhat-only harness exposing {ProtocolFeeMath} for unit tests.
contract ProtocolFeeMathHarness {
    function percentageFeeUsd(uint256 usdValue8) external pure returns (uint256) {
        return ProtocolFeeMath.percentageFeeUsd(usdValue8);
    }

    function feeUsdFromNotionalUsd(uint256 usdValue8) external pure returns (uint256) {
        return ProtocolFeeMath.feeUsdFromNotionalUsd(usdValue8);
    }

    function maxGasRefundWei() external pure returns (uint256) {
        return ProtocolFeeMath.maxGasRefundWei();
    }

    function requireGasRefundBounded(uint256 gasRefund, uint256 inputAmount) external pure {
        ProtocolFeeMath.requireGasRefundBounded(gasRefund, inputAmount);
    }

    function requireExactProtocolFee(uint256 supplied, uint256 required) external pure {
        ProtocolFeeMath.requireExactProtocolFee(supplied, required);
    }
}

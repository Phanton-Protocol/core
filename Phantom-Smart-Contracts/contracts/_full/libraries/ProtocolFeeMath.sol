// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "./DexSwapFee.sol";

/**
 * @title ProtocolFeeMath
 * @notice Canonical Phantom protocol fee / gas-refund policy (E-paper §1.8).
 * @dev Protocol fee = max($2 USD, 0.5% of notional). Join-split adds 10 bps DEX fee on full input.
 *      Rounding: multiply before divide; fees round down (favor user). No 1% underpayment slack.
 */
library ProtocolFeeMath {
  uint256 internal constant USD_DECIMALS = 8;
  /// @notice Minimum protocol fee: $2 (8-decimal USD).
  uint256 internal constant FEE_FLOOR_USD = 2 * 10 ** USD_DECIMALS;
  /// @notice 0.5% protocol fee = 50 bps of 10_000.
  uint256 internal constant PROTOCOL_FEE_BPS = 50;
  uint256 internal constant BPS_DENOMINATOR = 10_000;

  /// @notice Relayer gas refund cap: `GAS_REFUND_GAS_UNITS` at up to `MAX_GAS_PRICE_WEI`.
  uint256 internal constant GAS_REFUND_GAS_UNITS = 200_000;
  uint256 internal constant MAX_GAS_PRICE_WEI = 20 gwei;

  error ProtocolFeeMismatch(uint256 supplied, uint256 required);
  error GasRefundExceedsInput(uint256 gasRefund, uint256 inputAmount);
  error GasRefundExceedsCap(uint256 gasRefund, uint256 cap);

  function maxGasRefundWei() internal pure returns (uint256) {
    return GAS_REFUND_GAS_UNITS * MAX_GAS_PRICE_WEI;
  }

  /// @notice Percentage component in 8-decimal USD before floor.
  function percentageFeeUsd(uint256 usdValue8) internal pure returns (uint256) {
    return (usdValue8 * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
  }

  /// @notice max(0.5% of USD notional, $2 USD).
  function feeUsdFromNotionalUsd(uint256 usdValue8) internal pure returns (uint256 feeUsd8) {
    uint256 percentUsd = percentageFeeUsd(usdValue8);
    return percentUsd > FEE_FLOOR_USD ? percentUsd : FEE_FLOOR_USD;
  }

  /// @notice 0.5% of token amount when oracle price is unavailable (no USD floor).
  function percentageFeeInTokenUnits(uint256 amount) internal pure returns (uint256) {
    return (amount * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
  }

  /// @notice Join-split: oracle protocol fee + 10 bps DEX fee on full `inputAmount`.
  function joinSplitTotalProtocolFee(uint256 oracleProtocolFee, uint256 inputAmount) internal pure returns (uint256) {
    return oracleProtocolFee + DexSwapFee.swapFee(inputAmount);
  }

  function requireExactProtocolFee(uint256 supplied, uint256 required) internal pure {
    if (supplied != required) {
      revert ProtocolFeeMismatch(supplied, required);
    }
  }

  function requireGasRefundBounded(uint256 gasRefund, uint256 inputAmount) internal pure {
    if (gasRefund > inputAmount) {
      revert GasRefundExceedsInput(gasRefund, inputAmount);
    }
    uint256 cap = maxGasRefundWei();
    if (gasRefund > cap) {
      revert GasRefundExceedsCap(gasRefund, cap);
    }
  }

  /// @notice Deposit fee split: 25% executing relayer, 75% reward pool (integer-safe).
  function depositFeeShares(uint256 feeAmount) internal pure returns (uint256 executingShare, uint256 poolShare) {
    executingShare = feeAmount / 4;
    poolShare = feeAmount - executingShare;
  }

  /// @notice Cap deposit gas refund slice (matches legacy `tx.gasprice * 200_000` bound).
  function depositGasRefundSlice(uint256 depositFeeBNB, uint256 txGasPrice) internal pure returns (uint256) {
    uint256 estimated = txGasPrice * GAS_REFUND_GAS_UNITS;
    uint256 cap = maxGasRefundWei();
    if (estimated > cap) {
      estimated = cap;
    }
    return estimated > depositFeeBNB ? depositFeeBNB : estimated;
  }
}

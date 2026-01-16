// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../types/Types.sol";

/**
 * @title IPancakeSwapAdaptor
 * @notice Interface for PancakeSwap integration adaptor
 */
interface IPancakeSwapAdaptor {
    /**
     * @notice Executes a swap on PancakeSwap V3
     * @param swapParams Swap parameters
     * @return amountOut Actual amount received from swap
     */
    function executeSwap(
        SwapParams calldata swapParams
    ) external payable returns (uint256 amountOut);

    /**
     * @notice Gets the expected output amount for a swap (for slippage calculation)
     * @param swapParams Swap parameters
     * @return amountOut Expected output amount
     */
    function getExpectedOutput(
        SwapParams calldata swapParams
    ) external view returns (uint256 amountOut);
}

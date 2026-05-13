// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IPancakeSwapAdaptor.sol";

/**
 * @title MockSwapAdaptor
 * @notice Temporary mock for testing - returns amountIn as output (1:1)
 * @dev DO NOT USE IN PRODUCTION
 */
contract MockSwapAdaptor is IPancakeSwapAdaptor {
    function executeSwap(SwapParams calldata params) external payable override returns (uint256) {
        return params.amountIn; // 1:1 for E2E testing
    }
    function getExpectedOutput(SwapParams calldata params) external pure override returns (uint256) {
        return params.amountIn;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IPancakeSwapAdaptor.sol";

/**
 * @title MockReentrantSwapAdaptor
 * @notice Test-only adaptor that performs an external call during `executeSwap`.
 * @dev **NOT FOR PRODUCTION.** Used to prove pool `nonReentrant` blocks router-style callbacks.
 */
contract MockReentrantSwapAdaptor is IPancakeSwapAdaptor {
    address public callbackTarget;
    bytes public callbackData;

    function configureCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
    }

    function executeSwap(SwapParams calldata params) external payable override returns (uint256) {
        if (callbackTarget != address(0) && callbackData.length > 0) {
            (bool ok, bytes memory ret) = callbackTarget.call(callbackData);
            if (!ok) {
                if (ret.length > 0) {
                    assembly {
                        revert(add(ret, 32), mload(ret))
                    }
                }
                revert("MockReentrantSwapAdaptor: callback failed");
            }
        }
        return params.amountIn;
    }

    function getExpectedOutput(SwapParams calldata params) external pure override returns (uint256) {
        return params.amountIn;
    }
}

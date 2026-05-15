// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title TokenAccounting
 * @notice Strict ERC20 balance-delta checks for production fund flows.
 * @dev Fee-on-transfer, deflationary, and rebasing tokens that change balances without
 *      matching the declared `amount` are **unsupported** and revert with explicit errors.
 */
library TokenAccounting {
    using SafeERC20 for IERC20;

    /// @dev `transferFrom` credited less than `amount` to `to` (fee-on-transfer / deflationary).
    error ERC20ReceivedMismatch(address token, uint256 expected, uint256 received);
    /// @dev `transfer` credited less than `amount` to `to` (fee-on-transfer / deflationary).
    error ERC20DeliveredMismatch(address token, uint256 expected, uint256 delivered);

    function safeTransferFromExact(IERC20 token, address from, address to, uint256 amount) internal {
        uint256 balanceBefore = token.balanceOf(to);
        token.safeTransferFrom(from, to, amount);
        uint256 received = token.balanceOf(to) - balanceBefore;
        if (received != amount) {
            revert ERC20ReceivedMismatch(address(token), amount, received);
        }
    }

    function safeTransferExact(IERC20 token, address to, uint256 amount) internal {
        uint256 balanceBefore = token.balanceOf(to);
        token.safeTransfer(to, amount);
        uint256 delivered = token.balanceOf(to) - balanceBefore;
        if (delivered != amount) {
            revert ERC20DeliveredMismatch(address(token), amount, delivered);
        }
    }
}

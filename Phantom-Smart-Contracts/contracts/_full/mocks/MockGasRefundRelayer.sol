// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/// @dev Accepts native payouts via full-gas call (not 2300-stipend transfer).
contract MockGasRefundRelayer {
    receive() external payable {}
}

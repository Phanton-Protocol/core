// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/// @dev Reverts on native receive — for withdraw griefing regression tests.
contract MockRejectingReceiver {
    receive() external payable {
        revert("MockRejectingReceiver");
    }
}

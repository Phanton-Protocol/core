// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IntegrationMutability
 * @notice Shared bootstrap → timelock gate for integration/admin mutations (Module 6).
 * @dev When `timelock` is set and the target slot is non-zero, only the timelock may mutate.
 *      Otherwise the owner retains bootstrap authority.
 */
library IntegrationMutability {
    error NotTimelock();
    error NotAuthorized();

    function requireIntegrationCaller(
        address currentSlot,
        address timelock,
        address owner,
        address sender
    ) internal view {
        if (timelock != address(0) && currentSlot != address(0)) {
            if (sender != timelock) revert NotTimelock();
        } else if (sender != owner) {
            revert NotAuthorized();
        }
    }

    /// @notice Policy/admin mutations gated entirely by timelock once configured.
    function requireTimelockOrOwner(address timelock, address owner, address sender) internal view {
        if (timelock != address(0)) {
            if (sender != timelock) revert NotTimelock();
        } else if (sender != owner) {
            revert NotAuthorized();
        }
    }
}

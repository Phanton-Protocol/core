// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/**
 * @title TokenRegistrationPolicy
 * @notice Production ERC20 registration guards (standard tokens only).
 * @dev Rebasing / fee-on-transfer are rejected via {TokenAccounting} probe.
 *      ERC777-style hook tokens are rejected via ERC-165 when implemented.
 */
library TokenRegistrationPolicy {
    /// @dev IERC777 interface id (ERC-165).
    bytes4 internal constant ERC777_INTERFACE_ID = 0xe58e113c;

    error UnsupportedToken(address token, string reason);

    /// @notice Revert if `token` advertises ERC777 via ERC-165.
    function rejectErc777IfSupported(address token) internal view {
        if (token == address(0)) return;
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSelector(bytes4(keccak256("supportsInterface(bytes4)")), ERC777_INTERFACE_ID)
        );
        if (ok && data.length >= 32 && abi.decode(data, (bool))) {
            revert UnsupportedToken(token, "ERC777");
        }
    }
}

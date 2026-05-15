// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/**
 * @title TokenDecimals
 * @notice Canonical ERC20 decimal reads for fee / oracle math (never hardcode 18).
 */
library TokenDecimals {
  uint256 internal constant MAX_DECIMALS = 18;

  error UnsupportedDecimals(address token, uint256 decimals);

  /// @dev Native BNB is treated as 18 decimals.
  function read(address token) internal view returns (uint256) {
    if (token == address(0)) {
      return 18;
    }
    (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
    if (!ok || data.length < 32) {
      return 18;
    }
    uint256 d = uint256(uint8(bytes1(data[31])));
    if (d > MAX_DECIMALS) {
      revert UnsupportedDecimals(token, d);
    }
    return d;
  }
}

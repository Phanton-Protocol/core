// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IOffchainPriceOracle.sol";

/**
 * @notice Minimal off-chain oracle stub for BSC testnet when the previous offchain feed is stale.
 * @dev `FeeOracle.getUSDValue` offchain branch computes:
 *      `(amount * price) / 10**(18 - 8)` = `(amount * price) / 1e10`.
 *      With `price = 600`, 0.00333 BNB (`3.33e15` wei) maps to ~`2e8` USD scale (pool `$2` floor).
 */
contract FixedBnbUsdOffchainStub is IOffchainPriceOracle {
    uint256 public constant PRICE = 600;

    function getPrice(address) external view returns (uint256 price, uint256 updatedAt) {
        return (PRICE, block.timestamp);
    }
}

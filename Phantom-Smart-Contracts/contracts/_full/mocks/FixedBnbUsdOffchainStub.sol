// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IOffchainPriceOracle.sol";

/**
 * @notice Minimal off-chain oracle stub for BSC testnet when the previous offchain feed is stale.
 * @dev Returns BNB/USD with 8 decimals, matching `IOffchainPriceOracle`.
 *      Use a realistic value (e.g. $600 => 600 * 1e8) so `calculateFee` does not overcharge.
 */
contract FixedBnbUsdOffchainStub is IOffchainPriceOracle {
    uint256 public constant PRICE = 600 * 1e8;

    function getPrice(address) external view returns (uint256 price, uint256 updatedAt) {
        return (PRICE, block.timestamp);
    }
}

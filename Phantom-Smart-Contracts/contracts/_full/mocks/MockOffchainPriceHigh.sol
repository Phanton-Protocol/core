// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IOffchainPriceOracle.sol";

/// @notice Returns BNB/USD at $700 (8 decimals) for deviation-bound tests vs $600 Chainlink mock.
contract MockOffchainPriceHigh is IOffchainPriceOracle {
    uint256 public constant PRICE = 700 * 1e8;

    function getPrice(address) external view returns (uint256 price, uint256 updatedAt) {
        return (PRICE, block.timestamp);
    }
}

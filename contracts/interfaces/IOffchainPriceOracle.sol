// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IOffchainPriceOracle
 * @notice Interface for off-chain price oracle using signed updates
 */
interface IOffchainPriceOracle {
    /**
     * @notice Returns the latest price for a token
     * @dev Price is USD with 8 decimals (1e8)
     */
    function getPrice(address token) external view returns (uint256 price, uint256 updatedAt);
}

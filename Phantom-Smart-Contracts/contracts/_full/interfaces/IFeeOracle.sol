// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IFeeOracle
 * @notice Interface for dynamic fee calculation using Chainlink oracles
 */
interface IFeeOracle {
    /**
     * @notice Calculates the protocol fee for a transaction
     * @dev Fee = max($2 USD, 0.5% of transaction value) — see {ProtocolFeeMath}.
     * @param token Token address (for price conversion)
     * @param amount Transaction amount in token units
     * @return feeAmount Fee amount in token units
     */
    function calculateFee(
        address token,
        uint256 amount
    ) external view returns (uint256 feeAmount);

    /**
     * @notice Gets the USD value of a token amount
     * @param token Token address
     * @param amount Token amount
     * @return usdValue USD value (scaled by 1e8)
     */
    function getUSDValue(
        address token,
        uint256 amount
    ) external view returns (uint256 usdValue);

    /**
     * @notice Gets the token amount for a given USD value
     * @param token Token address (address(0) for native/BNB)
     * @param usdValue USD value (scaled by 1e8)
     * @return tokenAmount Token amount in token's decimals
     */
    function getTokenAmountForUSD(
        address token,
        uint256 usdValue
    ) external view returns (uint256 tokenAmount);

    /**
     * @notice Reverts if the latest price is stale (off-chain oracle)
     * @param token Token address
     */
    function requireFreshPrice(address token) external view;
}

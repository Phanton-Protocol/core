// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IFeeOracle.sol";
import "../interfaces/IOffchainPriceOracle.sol";

/**
 * @title FeeOracle
 * @notice Calculates dynamic protocol fees using Chainlink price feeds
 * @dev Fee = MAX($10 USD, 0.5% of transaction value)
 */
contract FeeOracle is IFeeOracle {
    // Chainlink price feed addresses (BSC mainnet)
    // These should be set to actual Chainlink aggregator addresses
    mapping(address => address) public priceFeeds; // token => priceFeed
    address public constant BNB_USD_FEED = address(0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE); // Example BSC Chainlink feed
    address public offchainOracle;
    
    uint256 public constant FEE_FLOOR_USD = 10 * 1e8; // $10 USD (8 decimals from Chainlink)
    uint256 public constant FEE_PERCENTAGE = 5; // 0.5% = 5 basis points (scaled by 1000)
    uint256 public constant BASIS_POINTS = 1000;
    uint256 public constant PRICE_FEED_DECIMALS = 8;

    address public owner;

    event PriceFeedUpdated(address indexed token, address indexed priceFeed);
    event OffchainOracleUpdated(address indexed oracle);

    modifier onlyOwner() {
        require(msg.sender == owner, "FeeOracle: not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        // Set default BNB price feed
        priceFeeds[address(0)] = BNB_USD_FEED;
    }

    /**
     * @notice Sets the Chainlink price feed for a token
     * @param token Token address (address(0) for BNB)
     * @param priceFeed Chainlink aggregator address
     */
    function setPriceFeed(address token, address priceFeed) external onlyOwner {
        require(priceFeed != address(0), "FeeOracle: zero address");
        priceFeeds[token] = priceFeed;
        emit PriceFeedUpdated(token, priceFeed);
    }

    /**
     * @notice Sets the off-chain oracle for signed price updates
     */
    function setOffchainOracle(address oracle) external onlyOwner {
        require(oracle != address(0), "FeeOracle: zero address");
        offchainOracle = oracle;
        emit OffchainOracleUpdated(oracle);
    }

    /**
     * @notice Gets the USD value of a token amount
     * @param token Token address
     * @param amount Token amount
     * @return usdValue USD value (scaled by 1e8)
     */
    function getUSDValue(
        address token,
        uint256 amount
    ) public view override returns (uint256 usdValue) {
        if (offchainOracle != address(0)) {
            (uint256 price, uint256 updatedAt) = IOffchainPriceOracle(offchainOracle).getPrice(token);
            require(price > 0, "FeeOracle: no offchain price");
            require(block.timestamp - updatedAt <= 10 minutes, "FeeOracle: stale offchain price");

            // USD value with 8 decimals
            return (amount * price) / (10 ** (18 - PRICE_FEED_DECIMALS));
        }

        address feed = priceFeeds[token];
        require(feed != address(0), "FeeOracle: price feed not set");
        
        // In production, this would call Chainlink aggregator
        // For now, returning a placeholder calculation
        // Actual implementation: (int256 price, , , , ) = AggregatorV3Interface(feed).latestRoundData();
        // usdValue = (amount * uint256(price)) / (10 ** (18 - PRICE_FEED_DECIMALS));
        
        // Placeholder: Chainlink integration not enabled
        return 0;
    }

    /**
     * @notice Reverts if the latest price is stale (off-chain oracle)
     */
    function requireFreshPrice(address token) external view override {
        if (offchainOracle == address(0)) {
            return;
        }

        (uint256 price, uint256 updatedAt) = IOffchainPriceOracle(offchainOracle).getPrice(token);
        require(price > 0, "FeeOracle: no offchain price");
        require(block.timestamp - updatedAt <= 10 minutes, "FeeOracle: stale offchain price");
    }

    /**
     * @notice Calculates the protocol fee for a transaction
     * @param token Token address
     * @param amount Transaction amount in token units
     * @return feeAmount Fee amount in token units
     */
    function calculateFee(
        address token,
        uint256 amount
    ) external view override returns (uint256 feeAmount) {
        // Get USD value of the transaction
        uint256 usdValue = getUSDValue(token, amount);
        
        // Calculate percentage fee (0.5%)
        uint256 percentageFeeUSD = (usdValue * FEE_PERCENTAGE) / (BASIS_POINTS * 100);
        
        // Take the maximum of floor and percentage fee
        uint256 feeUSD = percentageFeeUSD > FEE_FLOOR_USD ? percentageFeeUSD : FEE_FLOOR_USD;
        
        // Convert USD fee back to token units
        // feeAmount = (feeUSD * 10**tokenDecimals) / price
        // Simplified for now - actual implementation needs token decimals and price conversion
        uint256 tokenDecimals = _getTokenDecimals(token);
        feeAmount = (feeUSD * (10 ** tokenDecimals)) / (10 ** PRICE_FEED_DECIMALS);
        
        // Ensure fee doesn't exceed transaction amount
        if (feeAmount > amount) {
            feeAmount = amount;
        }
        
        return feeAmount;
    }

    function _getTokenDecimals(address token) internal view returns (uint256) {
        if (token == address(0)) return 18;
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("decimals()")
        );
        if (ok && data.length >= 32) {
            return uint256(uint8(bytes1(data[31])));
        }
        return 18;
    }
}

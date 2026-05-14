// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IFeeOracle.sol";
import "../interfaces/IOffchainPriceOracle.sol";
import "../interfaces/AggregatorV3Interface.sol";

/**
 * @title FeeOracle
 * @notice Calculates dynamic protocol fees using Chainlink price feeds
 * @dev Fee = MAX($2 USD, 0.5% of transaction value)
 */
contract FeeOracle is IFeeOracle {
    // Chainlink price feed addresses (BSC mainnet)
    // These should be set to actual Chainlink aggregator addresses
    mapping(address => address) public priceFeeds; // token => priceFeed
    address public constant BNB_USD_FEED = address(0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE); // Example BSC Chainlink feed
    address public offchainOracle;
    
    uint256 public constant FEE_FLOOR_USD = 2 * 1e8; // $2 USD (8 decimals from Chainlink)
    uint256 public constant FEE_PERCENTAGE = 5; // 0.5% = 5 basis points (scaled by 1000)
    uint256 public constant BASIS_POINTS = 1000;
    uint256 public constant PRICE_FEED_DECIMALS = 8;
    uint256 public maxFeedAgeSeconds = 3 minutes;

    address public owner;

    event PriceFeedUpdated(address indexed token, address indexed priceFeed);
    event OffchainOracleUpdated(address indexed oracle);
    event MaxFeedAgeUpdated(uint256 newAge);

    modifier onlyOwner() {
        require(msg.sender == owner, "FeeOracle: not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        // Mainnet BNB/USD — override on testnet via setPriceFeed(address(0), <testnet feed>)
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

    function setMaxFeedAge(uint256 newAge) external onlyOwner {
        require(newAge >= 1 minutes, "FeeOracle: too tight");
        require(newAge <= 1 hours, "FeeOracle: too permissive");
        maxFeedAgeSeconds = newAge;
        emit MaxFeedAgeUpdated(newAge);
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

            // USD value with 8 decimals (match Chainlink branch: amountWei * price / 10^tokenDecimals)
            uint256 tokenDecimals = _getTokenDecimals(token);
            return (amount * price) / (10 ** tokenDecimals);
        }

        address feed = priceFeeds[token];
        if (feed == address(0)) {
            return 0;
        }
        if (feed.code.length == 0) {
            // Misconfigured address (e.g. mainnet feed on local node) — behave like unset
            return 0;
        }

        try AggregatorV3Interface(feed).latestRoundData() returns (
            uint80,
            int256 answer,
            uint256,
            uint256 updatedAt,
            uint80
        ) {
            if (answer <= 0) {
                return 0;
            }
            if (block.timestamp - updatedAt > maxFeedAgeSeconds) {
                revert("FeeOracle: stale Chainlink price feed");
            }
            uint8 feedDecimals = AggregatorV3Interface(feed).decimals();
            uint256 tokenDecimals = _getTokenDecimals(token);
            // USD value with 8 decimals: amount * price / 10^(tokenDec + feedDec - 8)
            return (amount * uint256(answer)) / (10 ** (tokenDecimals + feedDecimals - PRICE_FEED_DECIMALS));
        } catch {
            return 0;
        }
    }

    /**
     * @notice Gets the token amount for a given USD value
     * @param token Token address
     * @param usdValue USD value (scaled by 1e8)
     * @return tokenAmount Token amount
     */
    function getTokenAmountForUSD(
        address token,
        uint256 usdValue
    ) public view override returns (uint256 tokenAmount) {
        if (usdValue == 0) return 0;
        uint256 tokenDecimals = _getTokenDecimals(token);
        (uint256 price, bool hasPrice) = _getTokenPrice(token);
        require(hasPrice && price > 0, "FeeOracle: price not available");
        return (usdValue * (10 ** tokenDecimals)) / price;
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
        if (amount == 0) return 0;

        // Get USD value of the transaction
        uint256 usdValue = getUSDValue(token, amount);
        
        // Calculate percentage fee (0.5%)
        uint256 percentageFeeUSD = (usdValue * FEE_PERCENTAGE) / (BASIS_POINTS * 100);
        
        // Take the maximum of floor and percentage fee
        uint256 feeUSD = percentageFeeUSD > FEE_FLOOR_USD ? percentageFeeUSD : FEE_FLOOR_USD;

        // Convert USD fee back to token units using real token price.
        // If price is unavailable, fall back to percentage fee in token units (no USD floor),
        // otherwise tiny testnet amounts get overcharged and swaps fail.
        (uint256 price, bool hasPrice) = _getTokenPrice(token);
        if (hasPrice && price > 0) {
            uint256 tokenDecimals = _getTokenDecimals(token);
            feeAmount = (feeUSD * (10 ** tokenDecimals)) / price;
        } else {
            feeAmount = (amount * FEE_PERCENTAGE) / (BASIS_POINTS * 100);
        }
        
        // Ensure fee doesn't exceed transaction amount
        if (feeAmount > amount) {
            feeAmount = amount;
        }
        
        return feeAmount;
    }

    function _getTokenPrice(address token) internal view returns (uint256 price, bool hasPrice) {
        if (offchainOracle != address(0)) {
            try IOffchainPriceOracle(offchainOracle).getPrice(token) returns (uint256 p, uint256 updatedAt) {
                if (p > 0 && block.timestamp - updatedAt <= 10 minutes) {
                    return (p, true);
                }
                return (0, false);
            } catch {
                return (0, false);
            }
        }

        address feed = priceFeeds[token];
        if (feed == address(0) || feed.code.length == 0) {
            return (0, false);
        }

        try AggregatorV3Interface(feed).latestRoundData() returns (
            uint80,
            int256 answer,
            uint256,
            uint256 updatedAt,
            uint80
        ) {
            if (answer <= 0) {
                return (0, false);
            }
            if (block.timestamp - updatedAt > maxFeedAgeSeconds) {
                revert("FeeOracle: stale Chainlink price feed");
            }
            uint8 feedDecimals = AggregatorV3Interface(feed).decimals();
            if (feedDecimals == PRICE_FEED_DECIMALS) {
                return (uint256(answer), true);
            }
            if (feedDecimals > PRICE_FEED_DECIMALS) {
                return (uint256(answer) / (10 ** (feedDecimals - PRICE_FEED_DECIMALS)), true);
            }
            return (uint256(answer) * (10 ** (PRICE_FEED_DECIMALS - feedDecimals)), true);
        } catch {
            return (0, false);
        }
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

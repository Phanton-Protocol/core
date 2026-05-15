// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IFeeOracle.sol";
import "../interfaces/IOffchainPriceOracle.sol";
import "../interfaces/AggregatorV3Interface.sol";
import "../libraries/OracleMath.sol";
import "../libraries/ProtocolFeeMath.sol";
import "../libraries/TokenDecimals.sol";

/**
 * @title FeeOracle
 * @notice Calculates dynamic protocol fees using Chainlink or off-chain price feeds.
 * @dev Fee = max($2 USD, 0.5% of transaction value) — see {ProtocolFeeMath}.
 */
contract FeeOracle is IFeeOracle {
    mapping(address => address) public priceFeeds;
    address public constant BNB_USD_FEED = address(0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE);
    address public offchainOracle;

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
        priceFeeds[address(0)] = BNB_USD_FEED;
    }

    function setPriceFeed(address token, address priceFeed) external onlyOwner {
        require(priceFeed != address(0), "FeeOracle: zero address");
        priceFeeds[token] = priceFeed;
        emit PriceFeedUpdated(token, priceFeed);
    }

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

    function getUSDValue(address token, uint256 amount) public view override returns (uint256 usdValue) {
        if (amount == 0) {
            return 0;
        }

        if (offchainOracle != address(0)) {
            (uint256 price, uint256 updatedAt) = IOffchainPriceOracle(offchainOracle).getPrice(token);
            require(price > 0, "FeeOracle: no offchain price");
            require(block.timestamp - updatedAt <= 10 minutes, "FeeOracle: stale offchain price");
            uint256 tokenDecimals = TokenDecimals.read(token);
            return OracleMath.usdValueFromAmountAndPrice(amount, price, tokenDecimals);
        }

        address feed = priceFeeds[token];
        if (feed == address(0)) {
            return 0;
        }
        if (feed.code.length == 0) {
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
            uint256 tokenDecimals = TokenDecimals.read(token);
            return OracleMath.usdValueFromChainlinkAnswer(
                amount,
                uint256(answer),
                tokenDecimals,
                feedDecimals
            );
        } catch {
            return 0;
        }
    }

    function getTokenAmountForUSD(
        address token,
        uint256 usdValue
    ) public view override returns (uint256 tokenAmount) {
        if (usdValue == 0) return 0;
        uint256 tokenDecimals = TokenDecimals.read(token);
        (uint256 price, bool hasPrice) = _getTokenPrice(token);
        require(hasPrice && price > 0, "FeeOracle: price not available");
        return OracleMath.tokenAmountFromUsd(usdValue, price, tokenDecimals);
    }

    function requireFreshPrice(address token) external view override {
        if (offchainOracle == address(0)) {
            return;
        }

        (uint256 price, uint256 updatedAt) = IOffchainPriceOracle(offchainOracle).getPrice(token);
        require(price > 0, "FeeOracle: no offchain price");
        require(block.timestamp - updatedAt <= 10 minutes, "FeeOracle: stale offchain price");
    }

    function calculateFee(
        address token,
        uint256 amount
    ) external view override returns (uint256 feeAmount) {
        if (amount == 0) return 0;

        uint256 usdValue = getUSDValue(token, amount);
        uint256 feeUSD = ProtocolFeeMath.feeUsdFromNotionalUsd(usdValue);

        (uint256 price, bool hasPrice) = _getTokenPrice(token);
        if (hasPrice && price > 0) {
            uint256 tokenDecimals = TokenDecimals.read(token);
            feeAmount = OracleMath.tokenAmountFromUsd(feeUSD, price, tokenDecimals);
        } else {
            feeAmount = ProtocolFeeMath.percentageFeeInTokenUnits(amount);
        }

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
            return (OracleMath.normalizeFeedAnswerToUsd8(uint256(answer), feedDecimals), true);
        } catch {
            return (0, false);
        }
    }
}

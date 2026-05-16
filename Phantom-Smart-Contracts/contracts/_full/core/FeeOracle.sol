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
 *      **Spot feeds only (no TWAP).** Used for protocol/deposit fees, not DEX swap pricing.
 *      Chainlink/off-chain answers are instantaneous spot — vulnerable to oracle lag, stale
 *      prints, and short-lived manipulation around updates. Not suitable as a manipulation-resistant
 *      DEX price oracle; pair with monitoring, feed pause runbooks, and timelock-gated feed changes.
 *      {calculateFee} and {getUSDValue} revert {PriceUnavailable} when no fresh price exists.
 *      BNB/USD feed is **not** defaulted in the constructor — deploy scripts must set per-network feed.
 *      Off-chain oracle is forbidden on BSC mainnet (chainId 56) and bounded vs Chainlink elsewhere.
 *      Feed/oracle/max-age mutations require timelock after {initializeTimelock} (bootstrap owner-only).
 */
contract FeeOracle is IFeeOracle {
    error PriceUnavailable(address token);
    error OffchainForbiddenOnMainnet();
    error OffchainDeviationExceeded(address token);
    error StaleChainlinkFeed(address token);
    error NotTimelock();
    error NotAuthorized();

    uint256 private constant BSC_MAINNET_CHAIN_ID = 56;
    uint256 private constant MAX_OFFCHAIN_DEVIATION_BPS = 500;
    uint256 private constant OFFCHAIN_MAX_AGE = 10 minutes;

    mapping(address => address) public priceFeeds;
    mapping(address => uint8) private _cachedDecimals;
    mapping(address => bool) private _hasCachedDecimals;
    address public offchainOracle;

    uint256 public maxFeedAgeSeconds = 3 minutes;

    address public owner;
    address public timelock;

    event PriceFeedUpdated(address indexed token, address indexed priceFeed);
    event OffchainOracleUpdated(address indexed oracle);
    event MaxFeedAgeUpdated(uint256 newAge);
    event TimelockSet(address indexed timelock);

    modifier onlyOwner() {
        require(msg.sender == owner, "FeeOracle: not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function initializeTimelock(address _timelock) external onlyOwner {
        require(_timelock != address(0), "FeeOracle: zero timelock");
        timelock = _timelock;
        emit TimelockSet(_timelock);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "FeeOracle: zero owner");
        owner = newOwner;
    }

    function _requireIntegrationCaller(address currentSlot) internal view {
        if (timelock != address(0) && currentSlot != address(0)) {
            if (msg.sender != timelock) revert NotTimelock();
        } else if (msg.sender != owner) {
            revert NotAuthorized();
        }
    }

    function _requireTimelockOrOwner() internal view {
        if (timelock != address(0)) {
            if (msg.sender != timelock) revert NotTimelock();
        } else if (msg.sender != owner) {
            revert NotAuthorized();
        }
    }

    function setPriceFeed(address token, address priceFeed) external {
        _requireIntegrationCaller(priceFeeds[token]);
        require(priceFeed != address(0), "FeeOracle: zero address");
        priceFeeds[token] = priceFeed;
        if (token != address(0)) {
            _cachedDecimals[token] = uint8(TokenDecimals.read(token));
            _hasCachedDecimals[token] = true;
        }
        emit PriceFeedUpdated(token, priceFeed);
    }

    function setOffchainOracle(address oracle) external {
        _requireIntegrationCaller(offchainOracle);
        if (oracle != address(0) && block.chainid == BSC_MAINNET_CHAIN_ID) {
            revert OffchainForbiddenOnMainnet();
        }
        offchainOracle = oracle;
        emit OffchainOracleUpdated(oracle);
    }

    function setMaxFeedAge(uint256 newAge) external {
        _requireTimelockOrOwner();
        require(newAge >= 1 minutes, "FeeOracle: too tight");
        require(newAge <= 1 hours, "FeeOracle: too permissive");
        maxFeedAgeSeconds = newAge;
        emit MaxFeedAgeUpdated(newAge);
    }

    function getUSDValue(address token, uint256 amount) public view override returns (uint256 usdValue) {
        if (amount == 0) {
            return 0;
        }
        (uint256 price, bool hasPrice) = _getTokenPrice(token);
        if (!hasPrice || price == 0) revert PriceUnavailable(token);
        return OracleMath.usdValueFromAmountAndPrice(amount, price, _tokenDecimals(token));
    }

    function getTokenAmountForUSD(
        address token,
        uint256 usdValue
    ) public view override returns (uint256 tokenAmount) {
        if (usdValue == 0) return 0;
        (uint256 price, bool hasPrice) = _getTokenPrice(token);
        if (!hasPrice || price == 0) revert PriceUnavailable(token);
        return OracleMath.tokenAmountFromUsd(usdValue, price, _tokenDecimals(token));
    }

    function requireFreshPrice(address token) external view override {
        (uint256 price, bool hasPrice) = _getTokenPrice(token);
        if (!hasPrice || price == 0) revert PriceUnavailable(token);
    }

    function calculateFee(
        address token,
        uint256 amount
    ) external view override returns (uint256 feeAmount) {
        if (amount == 0) return 0;

        (uint256 price, bool hasPrice) = _getTokenPrice(token);
        if (!hasPrice || price == 0) revert PriceUnavailable(token);

        uint256 usdValue = OracleMath.usdValueFromAmountAndPrice(amount, price, _tokenDecimals(token));
        uint256 feeUSD = ProtocolFeeMath.feeUsdFromNotionalUsd(usdValue);
        feeAmount = OracleMath.tokenAmountFromUsd(feeUSD, price, _tokenDecimals(token));

        if (feeAmount > amount) {
            feeAmount = amount;
        }

        return feeAmount;
    }

    function _getTokenPrice(address token) internal view returns (uint256 price, bool hasPrice) {
        (uint256 chainPrice, bool chainOk) = _readChainlinkPrice(token);

        if (offchainOracle != address(0)) {
            (uint256 offPrice, bool offOk) = _readOffchainPrice(token);
            if (offOk && offPrice > 0) {
                if (chainOk && chainPrice > 0) {
                    _requireOffchainWithinBound(token, offPrice, chainPrice);
                }
                return (offPrice, true);
            }
            if (chainOk && chainPrice > 0) {
                return (chainPrice, true);
            }
            return (0, false);
        }

        if (chainOk && chainPrice > 0) {
            return (chainPrice, true);
        }
        return (0, false);
    }

    function _readChainlinkPrice(address token) internal view returns (uint256 price, bool ok) {
        address feed = priceFeeds[token];
        if (feed == address(0) || feed.code.length == 0) {
            return (0, false);
        }

        try AggregatorV3Interface(feed).latestRoundData() returns (
            uint80 roundId,
            int256 answer,
            uint256,
            uint256 updatedAt,
            uint80 answeredInRound
        ) {
            if (updatedAt == 0 || answer <= 0 || answeredInRound < roundId) {
                return (0, false);
            }
            if (block.timestamp - updatedAt > maxFeedAgeSeconds) {
                revert StaleChainlinkFeed(token);
            }
            uint8 feedDecimals = AggregatorV3Interface(feed).decimals();
            return (OracleMath.normalizeFeedAnswerToUsd8(uint256(answer), feedDecimals), true);
        } catch {
            return (0, false);
        }
    }

    function _readOffchainPrice(address token) internal view returns (uint256 price, bool ok) {
        try IOffchainPriceOracle(offchainOracle).getPrice(token) returns (uint256 p, uint256 updatedAt) {
            if (p == 0 || updatedAt == 0 || block.timestamp - updatedAt > OFFCHAIN_MAX_AGE) {
                return (0, false);
            }
            return (p, true);
        } catch {
            return (0, false);
        }
    }

    function _requireOffchainWithinBound(address token, uint256 offPrice, uint256 chainPrice) internal pure {
        uint256 diff = offPrice > chainPrice ? offPrice - chainPrice : chainPrice - offPrice;
        if (diff * 10000 / chainPrice > MAX_OFFCHAIN_DEVIATION_BPS) {
            revert OffchainDeviationExceeded(token);
        }
    }

    function _tokenDecimals(address token) internal view returns (uint256) {
        if (token == address(0)) {
            return 18;
        }
        if (_hasCachedDecimals[token]) {
            return _cachedDecimals[token];
        }
        return TokenDecimals.read(token);
    }
}

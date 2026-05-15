// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/**
 * @title OracleMath
 * @notice USD valuation normalization (8-decimal USD) shared by Chainlink and off-chain feeds.
 * @dev Off-chain `IOffchainPriceOracle.getPrice` MUST return USD per **1 whole token** with 8 decimals
 *      (e.g. BNB at $600 => `600 * 1e8`), matching normalized Chainlink prices from {normalizeFeedAnswerToUsd8}.
 */
library OracleMath {
  uint256 internal constant USD_DECIMALS = 8;

  /// @notice USD value (8 decimals) from amount (token smallest units) and price per whole token (8-dec USD).
  function usdValueFromAmountAndPrice(
    uint256 amount,
    uint256 priceUsd8PerWholeToken,
    uint256 tokenDecimals
  ) internal pure returns (uint256 usdValue8) {
    return (amount * priceUsd8PerWholeToken) / (10 ** tokenDecimals);
  }

  /// @notice Chainlink `latestRoundData` answer → 8-decimal USD price per whole token.
  function normalizeFeedAnswerToUsd8(uint256 answer, uint256 feedDecimals) internal pure returns (uint256 priceUsd8) {
    if (feedDecimals == USD_DECIMALS) {
      return answer;
    }
    if (feedDecimals > USD_DECIMALS) {
      return answer / (10 ** (feedDecimals - USD_DECIMALS));
    }
    return answer * (10 ** (USD_DECIMALS - feedDecimals));
  }

  /// @notice USD value from raw Chainlink answer (any feed decimals).
  function usdValueFromChainlinkAnswer(
    uint256 amount,
    uint256 answer,
    uint256 tokenDecimals,
    uint256 feedDecimals
  ) internal pure returns (uint256 usdValue8) {
    uint256 exp = tokenDecimals + feedDecimals - USD_DECIMALS;
    return (amount * answer) / (10 ** exp);
  }

  /// @notice Convert 8-decimal USD notional to token smallest units.
  function tokenAmountFromUsd(
    uint256 usdValue8,
    uint256 priceUsd8PerWholeToken,
    uint256 tokenDecimals
  ) internal pure returns (uint256 tokenAmount) {
    return (usdValue8 * (10 ** tokenDecimals)) / priceUsd8PerWholeToken;
  }
}

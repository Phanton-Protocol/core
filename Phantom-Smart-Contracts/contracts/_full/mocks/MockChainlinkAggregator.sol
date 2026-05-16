// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @notice Minimal Chainlink-style feed for Hardhat tests (BNB/USD, etc.).
 */
contract MockChainlinkAggregator {
    int256 public answer;
    uint8 public constant decimals = 8;
    uint256 public updatedAt;
    uint80 public roundId = 1;
    uint80 public answeredInRound = 1;

    constructor(int256 _answer) {
        answer = _answer;
        updatedAt = block.timestamp;
    }

    function setAnswer(int256 _answer) external {
        answer = _answer;
    }

    function setUpdatedAt(uint256 _updatedAt) external {
        updatedAt = _updatedAt;
    }

    function setRoundData(uint80 _roundId, uint80 _answeredInRound) external {
        roundId = _roundId;
        answeredInRound = _answeredInRound;
    }

    function latestRoundData()
        external
        view
        returns (uint80 rid, int256 ans, uint256 startedAt, uint256 upd, uint80 air)
    {
        return (roundId, answer, 0, updatedAt, answeredInRound);
    }
}

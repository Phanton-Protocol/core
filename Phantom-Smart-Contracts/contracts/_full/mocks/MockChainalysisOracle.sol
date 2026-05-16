// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IChainalysisOracle.sol";

/**
 * @notice Test double for {IChainalysisOracle} used in Module 6 compliance tests.
 */
contract MockChainalysisOracle is IChainalysisOracle {
    mapping(address => uint256) public riskScore;
    mapping(address => bool) public sanctioned;

    function setAddressRisk(address addr, uint256 score, bool isSanctioned) external {
        riskScore[addr] = score;
        sanctioned[addr] = isSanctioned;
    }

    function checkAddress(address addr)
        external
        view
        override
        returns (uint256 score, bool isSanctioned, string memory riskCategory)
    {
        return (riskScore[addr], sanctioned[addr], "");
    }

    function batchCheckAddresses(address[] calldata addrs)
        external
        view
        override
        returns (uint256[] memory scores, bool[] memory sanctionedStatus)
    {
        scores = new uint256[](addrs.length);
        sanctionedStatus = new bool[](addrs.length);
        for (uint256 i = 0; i < addrs.length; i++) {
            scores[i] = riskScore[addrs[i]];
            sanctionedStatus[i] = sanctioned[addrs[i]];
        }
    }
}

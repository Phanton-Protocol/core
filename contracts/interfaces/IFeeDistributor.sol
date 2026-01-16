// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFeeDistributor {
    function distributeFee(address token, uint256 amount) external payable;
}

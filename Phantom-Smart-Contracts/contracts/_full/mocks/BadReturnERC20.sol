// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BadReturnERC20
 * @notice Minimal ERC20 that returns `false` on `transfer` / `transferFrom`.
 * @dev **NOT FOR PRODUCTION.** SafeERC20 must revert on these paths.
 */
contract BadReturnERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MaliciousERC20Reentrant
 * @notice Test-only ERC20 that invokes an external call during `transferFrom`
 *         to simulate ERC777-style hooks / malicious callbacks.
 * @dev **NOT FOR PRODUCTION.** Used by Module 2 security tests only.
 */
contract MaliciousERC20Reentrant {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public callbackTarget;
    bytes public callbackData;
    bool public callbackEnabled;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function configureCallback(address target, bytes calldata data, bool enabled) external {
        callbackTarget = target;
        callbackData = data;
        callbackEnabled = enabled;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _runCallback();
        require(balanceOf[msg.sender] >= amount, "MalRe: bal");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _runCallback();
        require(balanceOf[from] >= amount, "MalRe: bal");
        require(allowance[from][msg.sender] >= amount, "MalRe: alw");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        allowance[from][msg.sender] -= amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function _runCallback() internal {
        if (!callbackEnabled || callbackTarget == address(0) || callbackData.length == 0) return;
        (bool ok, bytes memory ret) = callbackTarget.call(callbackData);
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert("MalRe: callback failed");
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title FeeOnTransferERC20
 * @notice Test-only token that burns `feeBps` on every transfer / transferFrom.
 * @dev **NOT FOR PRODUCTION.** Used to prove pools reject non-exact ERC20 accounting.
 */
contract FeeOnTransferERC20 {
    uint256 public constant FEE_BPS = 100; // 1%
    uint256 public constant BPS = 10000;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "FoT: allowance");
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        uint256 fee = (amount * FEE_BPS) / BPS;
        uint256 net = amount - fee;
        require(balanceOf[from] >= amount, "FoT: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += net;
        // fee burned (not credited anywhere)
    }
}

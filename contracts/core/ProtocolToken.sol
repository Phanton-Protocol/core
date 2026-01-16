// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ProtocolToken {
    string public name = "Shadow Token";
    string public symbol = "SHDW";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    address public owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "ProtocolToken: not owner");
        _;
    }

    constructor(address initialOwner) {
        owner = initialOwner;
        uint256 supply = 1_000_000_000 * 1e18;
        totalSupply = supply;
        balanceOf[initialOwner] = supply;
        emit Transfer(address(0), initialOwner, supply);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "ProtocolToken: insufficient allowance");
        allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ProtocolToken: zero address");
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "ProtocolToken: zero address");
        uint256 bal = balanceOf[from];
        require(bal >= amount, "ProtocolToken: insufficient balance");
        balanceOf[from] = bal - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

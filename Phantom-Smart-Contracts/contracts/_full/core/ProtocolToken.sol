// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";

/**
 * @title ProtocolToken
 * @notice Governance token with Compound-style checkpoints (ERC20Votes).
 * @dev Holders who receive tokens after deployment should call {delegate} (e.g. delegate to self)
 *      once so voting power is tracked; the initial supply holder is self-delegated in the constructor.
 */
contract ProtocolToken is ERC20Votes {
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "ProtocolToken: not owner");
        _;
    }

    constructor(address initialOwner) ERC20("Shadow Token", "SHDW") ERC20Permit("Shadow Token") {
        require(initialOwner != address(0), "ProtocolToken: zero address");
        owner = initialOwner;
        _mint(initialOwner, 1_000_000_000 * 10 ** decimals());
        _delegate(initialOwner, initialOwner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ProtocolToken: zero address");
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function _afterTokenTransfer(address from, address to, uint256 amount) internal override(ERC20Votes) {
        super._afterTokenTransfer(from, to, amount);
    }

    function _mint(address account, uint256 amount) internal override(ERC20Votes) {
        super._mint(account, amount);
    }

    function _burn(address account, uint256 amount) internal override(ERC20Votes) {
        super._burn(account, amount);
    }
}

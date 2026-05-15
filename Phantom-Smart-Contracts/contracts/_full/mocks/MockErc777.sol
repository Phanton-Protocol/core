// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice Minimal ERC777 marker for registration-policy tests (ERC-165 only).
 */
contract MockErc777 is ERC20 {
    constructor() ERC20("Mock777", "M777") {}

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0xe58e113c || interfaceId == 0x01ffc9a7;
    }
}

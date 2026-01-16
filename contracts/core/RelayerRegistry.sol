// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IRelayerRegistry.sol";

/**
 * @title RelayerRegistry
 * @notice Manages whitelisted relayers who can submit shielded transactions
 * @dev Only registered relayers can execute shieldedSwap to prevent spam
 */
contract RelayerRegistry is IRelayerRegistry {
    address public owner;
    mapping(address => bool) public relayers;

    event RelayerRegistered(address indexed relayer);
    event RelayerRemoved(address indexed relayer);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "RelayerRegistry: not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /**
     * @notice Checks if an address is a registered relayer
     */
    function isRelayer(address relayer) external view override returns (bool) {
        return relayers[relayer];
    }

    /**
     * @notice Registers a new relayer
     * @param relayer Address to register as relayer
     */
    function registerRelayer(address relayer) external override onlyOwner {
        require(relayer != address(0), "RelayerRegistry: zero address");
        require(!relayers[relayer], "RelayerRegistry: already registered");
        relayers[relayer] = true;
        emit RelayerRegistered(relayer);
    }

    /**
     * @notice Removes a relayer from the registry
     * @param relayer Address to remove
     */
    function removeRelayer(address relayer) external override onlyOwner {
        require(relayers[relayer], "RelayerRegistry: not registered");
        relayers[relayer] = false;
        emit RelayerRemoved(relayer);
    }

    /**
     * @notice Transfers ownership of the registry
     * @param newOwner New owner address
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "RelayerRegistry: zero address");
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}

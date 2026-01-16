// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IRelayerRegistry
 * @notice Interface for managing whitelisted relayers/stakers
 */
interface IRelayerRegistry {
    /**
     * @notice Checks if an address is a registered relayer
     * @param relayer Address to check
     * @return isRelayer True if address is a registered relayer
     */
    function isRelayer(address relayer) external view returns (bool isRelayer);

    /**
     * @notice Registers a new relayer (only owner)
     * @param relayer Address to register
     */
    function registerRelayer(address relayer) external;

    /**
     * @notice Removes a relayer (only owner)
     * @param relayer Address to remove
     */
    function removeRelayer(address relayer) external;
}

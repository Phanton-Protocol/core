// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/// @dev Force-compile OZ's ERC1967Proxy so Hardhat artifacts are available
///      to test fixtures. This file is **test-only** and is intentionally
///      under `contracts/_full/test/` (the upstream `LibraryTestHarness`
///      lives in the same folder and is treated the same way by the build).
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract TestProxyDeployerSentinel {
    // Forces the compiler to pull `ERC1967Proxy` into the artifact set; no
    // additional runtime logic. Never deploy this on a live network.
    function deployerSentinel() external pure returns (bytes32) {
        return type(ERC1967Proxy).creationCode.length > 0 ? bytes32(uint256(1)) : bytes32(0);
    }
}

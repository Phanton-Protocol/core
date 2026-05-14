// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {TimelockController as OZTimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title TimelockController (Phantom — OZ-backed)
 * @notice Production-grade timelock built on OpenZeppelin's audited
 *         `TimelockController`. Replaces the legacy Phantom timelock which had
 *         **no access control** on `scheduleUpgrade` / `executeUpgrade` /
 *         `cancelOperation`.
 *
 * @dev Module 1 audit fix (Critical):
 *      Previous version exposed permissionless scheduling/execution, allowing
 *      anyone to push arbitrary calls (including UUPS upgrades on
 *      `ShieldedPoolUpgradeable`, whose `_authorizeUpgrade` only checked
 *      `msg.sender == address(timelock)`).
 *
 *      This contract inherits OZ's role-based timelock with the canonical roles:
 *        - `PROPOSER_ROLE`        : may `schedule` / `scheduleBatch`
 *        - `EXECUTOR_ROLE`        : may `execute` / `executeBatch` (set to
 *                                   `address(0)` at deploy time to make the
 *                                   execution step open to anyone *after* the
 *                                   delay, mirroring OZ's recommended setup)
 *        - `CANCELLER_ROLE`       : may `cancel`
 *        - `DEFAULT_ADMIN_ROLE`   : may grant/revoke roles. Should be either
 *                                   the timelock itself (self-administered) or
 *                                   a multisig — never an EOA in production.
 *
 *      The contract intentionally keeps the **type name** `TimelockController`
 *      so existing storage slots in deployed `ShieldedPoolUpgradeable` proxies
 *      (which store `TimelockController public timelock`) remain ABI- and
 *      layout-compatible. Only the address pointed to needs to be migrated to
 *      this new implementation.
 *
 * @custom:security-contact security@phantom.protocol
 */
contract TimelockController is OZTimelockController {
    /// @notice Minimum delay enforced for **production** deployments (48h).
    /// @dev Constructors may pick any non-zero delay, but deployment scripts
    ///      MUST refuse to deploy production timelocks below this value.
    uint256 public constant MIN_PRODUCTION_DELAY = 48 hours;

    /// @notice Emitted once at construction so off-chain indexers can pin the
    ///         delay actually deployed.
    event TimelockDeployed(uint256 minDelay, address admin);

    /**
     * @param minDelay   Minimum delay (in seconds) between scheduling and
     *                   executing an operation. MUST be `>= MIN_PRODUCTION_DELAY`
     *                   on mainnet/testnet production.
     * @param proposers  Initial `PROPOSER_ROLE` and `CANCELLER_ROLE` holders.
     *                   This MUST be the Governance contract address (and
     *                   optionally a guardian multisig). Never an EOA in
     *                   production.
     * @param executors  Initial `EXECUTOR_ROLE` holders. Pass `[address(0)]`
     *                   to make execution permissionless after the delay
     *                   (recommended; anyone can pay gas to execute a
     *                   governance-approved call).
     * @param admin      `DEFAULT_ADMIN_ROLE`. Should be `address(0)` (timelock
     *                   self-administers) or a guardian multisig. Setting an
     *                   EOA here re-introduces single-key risk.
     */
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) OZTimelockController(minDelay, proposers, executors, admin) {
        emit TimelockDeployed(minDelay, admin);
    }
}

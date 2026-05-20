// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IFeeDistributor.sol";
import "../interfaces/IFeeOracle.sol";
import "./ProtocolFeeMath.sol";

/**
 * @title PoolHelpersLib
 * @notice M3 size-budget aid for {ShieldedPoolUpgradeableReduced}. Extracts the
 *         compliance staticcall pair and the protocol-fee distribution branches
 *         out of the pool into a linked library so the reduced pool stays under
 *         EIP-170 (24,576 bytes) after porting the internal-matching settle
 *         entrypoint. Behavior is bit-identical to the previous inlined helpers
 *         — only the bytecode location moves.
 *
 * @dev Linked at deploy time via the standard Solidity library DELEGATECALL
 *      placeholder. Both functions are `public` (not `external`) because the
 *      old inlined helpers were `internal` and we want library-call semantics
 *      from both `internal` and `external` callers in the pool.
 */
library PoolHelpersLib {
    using SafeERC20 for IERC20;

    error SP();

    /**
     * @notice Mirror of the old `_checkCompliance(address)` in the pool.
     * @dev Returns silently when `mod == address(0)` so an unconfigured
     *      compliance module behaves identically to the pre-M3 reduced pool.
     *      Reverts {SP} on any sanction / block hit OR if the compliance
     *      contract reverts (staticcall returns `ok == false`).
     */
    function checkCompliance(address mod, address account) public view {
        if (mod == address(0)) return;
        (bool ok, bytes memory data) = mod.staticcall(
            abi.encodeWithSignature("isSanctioned(address)", account)
        );
        if (!ok || (data.length > 0 && abi.decode(data, (bool)))) revert SP();
        (ok, data) = mod.staticcall(
            abi.encodeWithSignature("isBlocked(address)", account)
        );
        if (!ok || (data.length > 0 && abi.decode(data, (bool)))) revert SP();
    }

    /**
     * @notice Mirror of the old `_distributeProtocolFee(address,uint256)` in the pool.
     * @dev `registry` is the {IFeeDistributor}-typed relayer registry on the pool
     *      (cast from the `IRelayerRegistry` storage slot). Native fees flow via
     *      `{value: amount}`; ERC20 fees flow via `safeApprove` + `distributeFee`.
     */
    function distributeProtocolFee(address registry, address token, uint256 amount) public {
        if (amount == 0) return;
        if (token == address(0)) {
            IFeeDistributor(registry).distributeFee{value: amount}(address(0), amount);
        } else {
            IERC20(token).safeApprove(registry, amount);
            IFeeDistributor(registry).distributeFee(token, amount);
        }
    }

    /**
     * @notice Bit-identical port of the deposit-fee branch of
     *         `ShieldedPoolUpgradeableReduced._finalizeDepositLogic`.
     *         Returns the **delta** to add to the pool's `gasReserve`
     *         (caller does `gasReserve += delta`).
     * @dev When `feeOracle` and `registry` are both configured and `feeAmount > 0`,
     *      enforces the minimum-USD threshold and splits the BNB fee 75/25 between
     *      executing relayer (or pool gas reserve if no relayer) and the relayer
     *      reward pool. Otherwise the entire fee accrues to `gasReserve`.
     *      Called via DELEGATECALL so payable `.call{value:}` debits the **pool's**
     *      native balance.
     */
    function distributeDepositFee(
        address feeOracle,
        address registry,
        uint256 feeAmount,
        uint256 minFeeUsd,
        address relayer
    ) public returns (uint256 gasReserveDelta) {
        if (feeAmount > 0 && feeOracle != address(0) && registry != address(0)) {
            uint256 feeUsd = IFeeOracle(feeOracle).getUSDValue(address(0), feeAmount);
            if (feeUsd < minFeeUsd) revert SP();
            (uint256 executingRelayerShare, uint256 rewardPoolShare) = ProtocolFeeMath.depositFeeShares(feeAmount);

            if (executingRelayerShare > 0) {
                if (relayer != address(0)) {
                    (bool ok,) = payable(relayer).call{value: executingRelayerShare}("");
                    if (!ok) revert SP();
                } else {
                    gasReserveDelta += executingRelayerShare;
                }
            }
            if (rewardPoolShare > 0) {
                IFeeDistributor(registry).distributeFee{value: rewardPoolShare}(
                    address(0),
                    rewardPoolShare
                );
            }
        } else {
            gasReserveDelta = feeAmount;
        }
    }
}

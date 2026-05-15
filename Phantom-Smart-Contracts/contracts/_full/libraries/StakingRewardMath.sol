// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/**
 * @title StakingRewardMath
 * @notice MasterChef-style accrual with explicit rounding dust returned to the pool.
 * @dev `dust` is added to `unallocated` so no wei is lost to integer division.
 */
library StakingRewardMath {
    uint256 public constant REWARD_SCALE = 1e12;

    /// @return increment Amount to add to `accRewardPerShare`.
    /// @return dust Wei not credited to stakers (caller should add to `unallocatedRewards`).
    function accrueIncrement(uint256 amount, uint256 totalStaked) internal pure returns (uint256 increment, uint256 dust) {
        if (totalStaked == 0 || amount == 0) {
            return (0, amount);
        }
        uint256 scaled = amount * REWARD_SCALE;
        increment = scaled / totalStaked;
        uint256 distributed = (increment * totalStaked) / REWARD_SCALE;
        dust = amount - distributed;
    }
}

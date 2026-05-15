// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IRelayerRegistry.sol";
import "../interfaces/IFeeDistributor.sol";
import "../libraries/StakingRewardMath.sol";

/**
 * @title RelayerStaking
 * @notice Staking + fee distribution for relayers (MasterChef-style accounting).
 * @dev When `totalStaked == 0`, fees accrue in {unallocatedRewards} and roll into the next
 *      {accRewardPerShare} update on the first {stake} after idle (intended: no stranded fees).
 *      Late stakers must not earn rewards accrued before their stake: {stake} calls
 *      {_syncRewardDebt} after increasing balance so `rewardDebt` tracks the new stake.
 */
contract RelayerStaking is IRelayerRegistry, IFeeDistributor, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public owner;
    address public token;
    uint256 public minStake;
    address public feeRecipient;
    uint256 public claimFeeBps;

    uint256 public totalStaked;
    mapping(address => uint256) public stakedBalance;

    uint256 public constant MAX_REWARD_TOKENS = 20;

    address[] public rewardTokens;
    mapping(address => bool) public isRewardToken;
    mapping(address => uint256) public accRewardPerShare;
    mapping(address => mapping(address => uint256)) public rewardDebt;
    /// @notice Fees received while `totalStaked == 0`; merged on next distribution.
    mapping(address => uint256) public unallocatedRewards;

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event RewardTokenAdded(address indexed token);
    event FeeDistributed(address indexed token, uint256 amount);
    event RewardClaimed(address indexed user, address indexed token, uint256 amount);
    event ClaimFeeUpdated(uint256 bps);
    event FeeRecipientUpdated(address indexed recipient);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event MinStakeUpdated(uint256 minStake);
    event Slashed(address indexed staker, uint256 amount, address indexed slasher);
    event UnallocatedRewardsRolled(address indexed token, uint256 amount);

    mapping(address => bool) public isSlasher;

    modifier onlyOwner() {
        require(msg.sender == owner, "RelayerStaking: not owner");
        _;
    }

    modifier onlySlasher() {
        require(isSlasher[msg.sender], "RelayerStaking: not slasher");
        _;
    }

    constructor(address _token, uint256 _minStake) {
        require(_token != address(0), "RelayerStaking: zero token");
        owner = msg.sender;
        token = _token;
        minStake = _minStake;
        feeRecipient = msg.sender;
        claimFeeBps = 10;
    }

    function registerRelayer(address) external pure override {
        revert("RelayerStaking: stake to register");
    }

    function removeRelayer(address) external pure override {
        revert("RelayerStaking: stake to unregister");
    }

    function isRelayer(address relayer) external view override returns (bool) {
        return stakedBalance[relayer] >= minStake;
    }

    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "RelayerStaking: zero amount");
        _updateAllRewards(msg.sender);
        bool wasZero = totalStaked == 0;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        stakedBalance[msg.sender] += amount;
        totalStaked += amount;
        _syncRewardDebt(msg.sender);
        if (wasZero) {
            _rollAllUnallocatedRewards();
        }
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant {
        require(amount > 0, "RelayerStaking: zero amount");
        require(stakedBalance[msg.sender] >= amount, "RelayerStaking: insufficient stake");
        _updateAllRewards(msg.sender);
        stakedBalance[msg.sender] -= amount;
        totalStaked -= amount;
        _syncRewardDebt(msg.sender);
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function distributeFee(address feeToken, uint256 amount) external payable override nonReentrant {
        require(amount > 0, "RelayerStaking: zero amount");
        if (feeToken == address(0)) {
            require(msg.value == amount, "RelayerStaking: bad msg.value");
        } else {
            IERC20(feeToken).safeTransferFrom(msg.sender, address(this), amount);
        }

        if (!isRewardToken[feeToken]) {
            require(rewardTokens.length < MAX_REWARD_TOKENS, "RelayerStaking: max reward tokens reached");
            isRewardToken[feeToken] = true;
            rewardTokens.push(feeToken);
            emit RewardTokenAdded(feeToken);
        }

        if (totalStaked > 0) {
            uint256 toDistribute = amount;
            uint256 rolled = unallocatedRewards[feeToken];
            if (rolled > 0) {
                unallocatedRewards[feeToken] = 0;
                toDistribute += rolled;
                emit UnallocatedRewardsRolled(feeToken, rolled);
            }
            (uint256 increment, uint256 dust) = StakingRewardMath.accrueIncrement(toDistribute, totalStaked);
            if (increment > 0) {
                accRewardPerShare[feeToken] += increment;
            }
            if (dust > 0) {
                unallocatedRewards[feeToken] += dust;
            }
        } else {
            unallocatedRewards[feeToken] += amount;
        }
        emit FeeDistributed(feeToken, amount);
    }

    function claim(address feeToken) external nonReentrant {
        uint256 pending = _pending(msg.sender, feeToken);
        if (pending == 0) return;
        rewardDebt[msg.sender][feeToken] = (stakedBalance[msg.sender] * accRewardPerShare[feeToken]) / 1e12;
        _payout(msg.sender, feeToken, pending);
    }

    function setMinStake(uint256 amount) external onlyOwner {
        minStake = amount;
        emit MinStakeUpdated(amount);
    }

    function setClaimFeeBps(uint256 bps) external onlyOwner {
        require(bps <= 100, "RelayerStaking: fee too high");
        claimFeeBps = bps;
        emit ClaimFeeUpdated(bps);
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        require(recipient != address(0), "RelayerStaking: zero address");
        feeRecipient = recipient;
        emit FeeRecipientUpdated(recipient);
    }

    function addRewardToken(address feeToken) external onlyOwner {
        if (isRewardToken[feeToken]) return;
        require(rewardTokens.length < MAX_REWARD_TOKENS, "RelayerStaking: max reward tokens reached");
        isRewardToken[feeToken] = true;
        rewardTokens.push(feeToken);
        emit RewardTokenAdded(feeToken);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "RelayerStaking: zero address");
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function _pending(address user, address feeToken) internal view returns (uint256) {
        uint256 acc = accRewardPerShare[feeToken];
        uint256 debt = rewardDebt[user][feeToken];
        uint256 accumulated = (stakedBalance[user] * acc) / 1e12;
        if (accumulated <= debt) return 0;
        return accumulated - debt;
    }

    function pendingReward(address user, address feeToken) external view returns (uint256) {
        return _pending(user, feeToken);
    }

    function getRewardTokens() external view returns (address[] memory) {
        return rewardTokens;
    }

    function _rollAllUnallocatedRewards() internal {
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            address t = rewardTokens[i];
            uint256 rolled = unallocatedRewards[t];
            if (rolled == 0) continue;
            unallocatedRewards[t] = 0;
            (uint256 increment, uint256 dust) = StakingRewardMath.accrueIncrement(rolled, totalStaked);
            if (increment > 0) {
                accRewardPerShare[t] += increment;
            }
            if (dust > 0) {
                unallocatedRewards[t] += dust;
            }
            emit UnallocatedRewardsRolled(t, rolled);
        }
    }

    function _updateAllRewards(address user) internal {
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            address t = rewardTokens[i];
            uint256 pending = _pending(user, t);
            rewardDebt[user][t] = (stakedBalance[user] * accRewardPerShare[t]) / StakingRewardMath.REWARD_SCALE;
            if (pending > 0) {
                _payout(user, t, pending);
            }
        }
    }

    /// @dev Set `rewardDebt` to current stake × accumulator (post balance change).
    function _syncRewardDebt(address user) internal {
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            address t = rewardTokens[i];
            rewardDebt[user][t] = (stakedBalance[user] * accRewardPerShare[t]) / StakingRewardMath.REWARD_SCALE;
        }
    }

    function _payout(address user, address feeToken, uint256 amount) internal {
        uint256 fee = (amount * claimFeeBps) / 10000;
        uint256 net = amount - fee;
        if (fee > 0) {
            if (feeToken == address(0)) {
                payable(feeRecipient).transfer(fee);
            } else {
                IERC20(feeToken).safeTransfer(feeRecipient, fee);
            }
        }
        if (net > 0) {
            if (feeToken == address(0)) {
                payable(user).transfer(net);
            } else {
                IERC20(feeToken).safeTransfer(user, net);
            }
        }
        emit RewardClaimed(user, feeToken, net);
    }

    function slash(address staker, uint256 amount) external onlySlasher nonReentrant {
        require(stakedBalance[staker] >= amount, "RelayerStaking: insufficient balance to slash");

        _updateAllRewards(staker);
        stakedBalance[staker] -= amount;
        totalStaked -= amount;
        _syncRewardDebt(staker);

        IERC20(token).safeTransfer(feeRecipient, amount);

        emit Slashed(staker, amount, msg.sender);
    }

    function setSlasher(address slasher, bool enabled) external onlyOwner {
        isSlasher[slasher] = enabled;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IRelayerRegistry.sol";
import "../interfaces/IFeeDistributor.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract RelayerStaking is IRelayerRegistry, IFeeDistributor {
    address public owner;
    address public token;
    uint256 public minStake;
    address public feeRecipient;
    uint256 public claimFeeBps;

    uint256 public totalStaked;
    mapping(address => uint256) public stakedBalance;

    address[] public rewardTokens;
    mapping(address => bool) public isRewardToken;
    mapping(address => uint256) public accRewardPerShare;
    mapping(address => mapping(address => uint256)) public rewardDebt;

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
        claimFeeBps = 10; // 0.1%
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

    function stake(uint256 amount) external {
        require(amount > 0, "RelayerStaking: zero amount");
        _updateAllRewards(msg.sender);
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        stakedBalance[msg.sender] += amount;
        totalStaked += amount;
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external {
        require(amount > 0, "RelayerStaking: zero amount");
        require(stakedBalance[msg.sender] >= amount, "RelayerStaking: insufficient stake");
        _updateAllRewards(msg.sender);
        stakedBalance[msg.sender] -= amount;
        totalStaked -= amount;
        IERC20(token).transfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function distributeFee(address feeToken, uint256 amount) external payable override {
        require(amount > 0, "RelayerStaking: zero amount");
        if (feeToken == address(0)) {
            require(msg.value == amount, "RelayerStaking: bad msg.value");
        } else {
            IERC20(feeToken).transferFrom(msg.sender, address(this), amount);
        }

        if (!isRewardToken[feeToken]) {
            isRewardToken[feeToken] = true;
            rewardTokens.push(feeToken);
            emit RewardTokenAdded(feeToken);
        }

        if (totalStaked > 0) {
            accRewardPerShare[feeToken] += (amount * 1e12) / totalStaked;
        }
        emit FeeDistributed(feeToken, amount);
    }

    function claim(address feeToken) external {
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

    function _updateReward(address user, address feeToken) internal {
        uint256 pending = _pending(user, feeToken);
        if (pending > 0) {
            _payout(user, feeToken, pending);
        }
    }

    function _updateAllRewards(address user) internal {
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            address t = rewardTokens[i];
            _updateReward(user, t);
            rewardDebt[user][t] = (stakedBalance[user] * accRewardPerShare[t]) / 1e12;
        }
    }

    function _payout(address user, address feeToken, uint256 amount) internal {
        uint256 fee = (amount * claimFeeBps) / 10000;
        uint256 net = amount - fee;
        if (fee > 0) {
            if (feeToken == address(0)) {
                payable(feeRecipient).transfer(fee);
            } else {
                IERC20(feeToken).transfer(feeRecipient, fee);
            }
        }
        if (net > 0) {
            if (feeToken == address(0)) {
                payable(user).transfer(net);
            } else {
                IERC20(feeToken).transfer(user, net);
            }
        }
        emit RewardClaimed(user, feeToken, net);
    }

    /**
     * @notice Slash a staker's balance (callable by authorized slashers, e.g., DecentralizedVerifier)
     * @param staker The address to slash
     * @param amount The amount to slash
     */
    function slash(address staker, uint256 amount) external onlySlasher {
        require(stakedBalance[staker] >= amount, "RelayerStaking: insufficient balance to slash");
        
        _updateAllRewards(staker);
        stakedBalance[staker] -= amount;
        totalStaked -= amount;
        
        // Slashed tokens go to fee recipient (or could be burned)
        IERC20(token).transfer(feeRecipient, amount);
        
        emit Slashed(staker, amount, msg.sender);
    }

    /**
     * @notice Add or remove a slasher (e.g., DecentralizedVerifier contract)
     */
    function setSlasher(address slasher, bool enabled) external onlyOwner {
        isSlasher[slasher] = enabled;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../types/Types.sol";

/**
 * @title IShieldedPool
 * @notice Main interface for the Shadow-DeFi Shielded Pool
 */
interface IShieldedPool {
    /**
     * @notice Deposits tokens into the shielded pool
     * @dev Creates a commitment and adds it to the Merkle tree
     * @param token Token address to deposit (address(0) for BNB)
     * @param amount Amount to deposit
     * @param commitment The Pedersen commitment H(AssetID, Amount, BlindingFactor, OwnerPublicKey)
     * @param assetID Asset identifier (0 = BNB, 1 = USDT, etc.)
     */
    function deposit(
        address token,
        uint256 amount,
        bytes32 commitment,
        uint256 assetID
    ) external payable;

    /**
     * @notice Deposits tokens on behalf of a depositor (relayed)
     * @dev For ERC20 only; depositor must approve ShieldedPool
     * @param depositor Original user address
     * @param token Token address (must be ERC20, not BNB)
     * @param amount Amount to deposit
     * @param commitment Commitment for the note
     * @param assetID Asset identifier
     */
    function depositFor(
        address depositor,
        address token,
        uint256 amount,
        bytes32 commitment,
        uint256 assetID
    ) external;

    function depositForBNB(
        address depositor,
        bytes32 commitment,
        uint256 assetID
    ) external payable;

    /**
     * @notice Executes a shielded swap within the pool (Legacy - single output)
     * @dev Spends an input note, swaps via PancakeSwap, creates output note
     * @dev NOTE: Use shieldedSwapJoinSplit for partial swaps with change notes
     * @param swapData Complete swap transaction data including proof and parameters
     */
    function shieldedSwap(
        ShieldedSwapData calldata swapData
    ) external;

    /**
     * @notice Executes a join-split shielded swap within the pool
     * @dev Spends 1 input note, swaps via PancakeSwap, creates 2 output notes (swap result + change)
     * 
     * Conservation: Input_Amount = Swap_Amount + Change_Amount + Protocol_Fee + Gas_Refund
     * 
     * Example: Swap 4 BNB from a 10 BNB note
     * - Input: 10 BNB note (nullifier burned)
     * - Swap: 4 BNB → USDT (via PancakeSwap)
     * - Output 1: USDT note (swap result)
     * - Output 2: 6 BNB note (change, stays in pool)
     * 
     * @param swapData Join-split swap transaction data
     */
    function shieldedSwapJoinSplit(
        JoinSplitSwapData calldata swapData
    ) external;

    /**
     * @notice Executes a shielded withdrawal from the pool
     * @dev Spends 1 input note, withdraws to external address, creates 1 change note
     * 
     * Conservation: Input_Amount = Withdraw_Amount + Change_Amount + Protocol_Fee + Gas_Refund
     * 
     * Example: Withdraw 2 BNB from a 10 BNB note
     * - Input: 10 BNB note (nullifier burned)
     * - Withdraw: 2 BNB sent to recipient address
     * - Output: 8 BNB note (change, stays in pool)
     * 
     * @param withdrawData Join-split withdrawal transaction data
     */
    function shieldedWithdraw(
        ShieldedWithdrawData calldata withdrawData
    ) external;

    /**
     * @notice Gets the current Merkle root of the state tree
     * @return root Current Merkle root
     */
    function getMerkleRoot() external view returns (bytes32 root);

    /**
     * @notice Checks if a nullifier has been used (prevents double-spending)
     * @param nullifier The nullifier to check
     * @return used True if nullifier has been used, false otherwise
     */
    function isNullifierUsed(bytes32 nullifier) external view returns (bool used);

    /**
     * @notice Gets the total number of commitments in the tree
     * @return count Current commitment count
     */
    function getCommitmentCount() external view returns (uint256 count);
}

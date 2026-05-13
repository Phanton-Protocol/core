// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFHEExecutor {
    function submitEncryptedSwap(
        bytes calldata encryptedAmountIn,
        bytes calldata encryptedAmountOut,
        bytes32 commitment,
        bytes calldata proof
    ) external returns (bytes32 executionId);

    function getEncryptedResult(bytes32 executionId) external view returns (bytes memory);
}

interface IAdvancedPrivacyPool {
    function submitFHESwap(
        bytes calldata encryptedAmountIn,
        bytes calldata encryptedAmountOut,
        bytes32 commitment,
        bytes calldata proof
    ) external returns (bytes32 executionId);
}

contract ReentrantFHEExecutor is IFHEExecutor {
    IAdvancedPrivacyPool public immutable pool;
    bool public attemptedReentry;
    bool public reentryBlocked;
    bool public reentrySucceeded;
    uint256 private nonce;

    constructor(address poolAddress) {
        require(poolAddress != address(0), "ReentrantFHEExecutor: zero pool");
        pool = IAdvancedPrivacyPool(poolAddress);
    }

    function submitEncryptedSwap(
        bytes calldata encryptedAmountIn,
        bytes calldata encryptedAmountOut,
        bytes32 commitment,
        bytes calldata proof
    ) external override returns (bytes32 executionId) {
        if (!attemptedReentry) {
            attemptedReentry = true;
            try pool.submitFHESwap(encryptedAmountIn, encryptedAmountOut, commitment, proof) {
                reentrySucceeded = true;
            } catch {
                reentryBlocked = true;
            }
        }

        executionId = keccak256(abi.encodePacked(commitment, nonce++));
        return executionId;
    }

    function getEncryptedResult(bytes32) external pure override returns (bytes memory) {
        return "";
    }
}


// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/**
 * @title MevCommitReveal
 * @notice External library — commit-reveal + deadline gate for join-split (shrinks pool bytecode).
 */
library MevCommitReveal {
    error MevInvalid();

    uint256 internal constant MAX_DEADLINE_DURATION = 1 hours;

    function commit(
        mapping(bytes32 => bool) storage commitments,
        mapping(bytes32 => uint256) storage deadlines,
        bytes32 commitmentHash,
        uint256 deadline
    ) external {
        if (
            commitmentHash == bytes32(0) || deadline <= block.timestamp
                || deadline > block.timestamp + MAX_DEADLINE_DURATION || commitments[commitmentHash]
        ) {
            revert MevInvalid();
        }
        commitments[commitmentHash] = true;
        deadlines[commitmentHash] = deadline;
    }

    function verifyAndConsume(
        mapping(bytes32 => bool) storage commitments,
        mapping(bytes32 => uint256) storage deadlines,
        bytes32 commitment,
        uint256 deadline
    ) external {
        if (
            commitment == bytes32(0) || !commitments[commitment]
                || block.timestamp > deadlines[commitment] || block.timestamp > deadline
        ) {
            revert MevInvalid();
        }
        commitments[commitment] = false;
    }
}

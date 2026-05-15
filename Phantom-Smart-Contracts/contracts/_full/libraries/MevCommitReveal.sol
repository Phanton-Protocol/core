// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/**
 * @title MevCommitReveal
 * @notice External library — commit-reveal + deadline gate for join-split (shrinks pool bytecode).
 * @dev `committers[commitmentHash]` stores the relayer that committed (0 = none). Prevents squatting.
 */
library MevCommitReveal {
    error MevInvalid();

    uint256 internal constant MAX_DEADLINE_DURATION = 1 hours;

    function commit(
        mapping(bytes32 => address) storage committers,
        mapping(bytes32 => uint256) storage deadlines,
        bytes32 commitmentHash,
        uint256 deadline,
        address committer
    ) external {
        if (
            commitmentHash == bytes32(0) || committer == address(0) || committers[commitmentHash] != address(0)
                || deadline <= block.timestamp || deadline > block.timestamp + MAX_DEADLINE_DURATION
        ) {
            revert MevInvalid();
        }
        committers[commitmentHash] = committer;
        deadlines[commitmentHash] = deadline;
    }

    function verifyAndConsume(
        mapping(bytes32 => address) storage committers,
        mapping(bytes32 => uint256) storage deadlines,
        bytes32 commitment,
        uint256 deadline,
        address committer
    ) external {
        if (
            commitment == bytes32(0) || committer == address(0) || committers[commitment] != committer
                || block.timestamp > deadlines[commitment] || block.timestamp > deadline
        ) {
            revert MevInvalid();
        }
        committers[commitment] = address(0);
    }
}

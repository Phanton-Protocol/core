// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MiMC7.sol";
/**
 * @title MerkleTree
 * @notice Library for managing Merkle tree operations
 * @dev Supports incremental Merkle tree for efficient updates
 */
library MerkleTree {
    /**
     * @notice Calculates the Merkle root from a leaf and path
     * @param leaf The leaf node (commitment)
     * @param path Array of sibling nodes in the path
     * @param pathIndices Array indicating left (0) or right (1) for each path element
     * @param depth Depth of the tree (number of path elements)
     * @return root The calculated Merkle root
     */
    function calculateRoot(
        bytes32 leaf,
        bytes32[10] memory path,
        uint256[10] memory pathIndices,
        uint256 depth
    ) internal pure returns (bytes32 root) {
        uint256 current = uint256(leaf);
        for (uint256 i = 0; i < depth; i++) {
            if (pathIndices[i] == 0) {
                // Left child
                current = MiMC7.mimc7(current, uint256(path[i]));
            } else {
                // Right child
                current = MiMC7.mimc7(uint256(path[i]), current);
            }
        }
        root = bytes32(current);
    }

    /**
     * @notice Verifies a Merkle proof
     * @param leaf The leaf node to verify
     * @param root The expected Merkle root
     * @param path Array of sibling nodes
     * @param pathIndices Array indicating left/right for each path element
     * @param depth Depth of the tree
     * @return valid True if proof is valid
     */
    function verifyProof(
        bytes32 leaf,
        bytes32 root,
        bytes32[10] memory path,
        uint256[10] memory pathIndices,
        uint256 depth
    ) internal pure returns (bool valid) {
        bytes32 calculatedRoot = calculateRoot(leaf, path, pathIndices, depth);
        return calculatedRoot == root;
    }
}

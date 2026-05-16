// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MiMC7.sol";
/**
 * @title IncrementalMerkleTree
 * @notice Incremental Merkle tree for append-only commitments
 * @dev Uses MiMC7(left, right) for internal nodes
 */
library IncrementalMerkleTree {
    /// @notice Reverted when `nextIndex` reaches `2**depth` (e.g. 1024 leaves at depth 10).
    error MerkleTreeFull();

    struct Tree {
        uint256 depth;
        uint256 nextIndex;
        bytes32 root;
        bytes32[10] zeros;
        mapping(uint256 => bytes32) filledSubtrees;
    }

    /**
     * @notice Initializes the tree with a given depth
     * @dev Depth must be <= 10 to match fixed-size arrays
     */
    function init(Tree storage self, uint256 depth) internal {
        require(depth > 0 && depth <= 10, "IncrementalMerkleTree: invalid depth");
        self.depth = depth;

        bytes32 currentZero = bytes32(0);
        self.zeros[0] = currentZero;
        for (uint256 i = 1; i < depth; i++) {
            uint256 h = MiMC7.mimc7(uint256(currentZero), uint256(currentZero));
            currentZero = bytes32(h);
            self.zeros[i] = currentZero;
        }

        self.root = self.zeros[depth - 1];
        self.nextIndex = 0;
    }

    /**
     * @notice Inserts a new leaf into the tree
     * @param leaf Commitment hash
     * @return index Index of the inserted leaf
     * @return newRoot Updated Merkle root
     */
    function insert(Tree storage self, bytes32 leaf) internal returns (uint256 index, bytes32 newRoot) {
        index = self.nextIndex;
        if (index >= (1 << self.depth)) revert MerkleTreeFull();

        bytes32 currentHash = leaf;
        uint256 currentIndex = index;

        for (uint256 i = 0; i < self.depth; i++) {
            if (currentIndex % 2 == 0) {
                self.filledSubtrees[i] = currentHash;
                currentHash = bytes32(MiMC7.mimc7(uint256(currentHash), uint256(self.zeros[i])));
            } else {
                currentHash = bytes32(MiMC7.mimc7(uint256(self.filledSubtrees[i]), uint256(currentHash)));
            }
            currentIndex /= 2;
        }

        self.root = currentHash;
        self.nextIndex = index + 1;
        return (index, currentHash);
    }

    /**
     * @notice Returns the current Merkle root
     */
    function getRoot(Tree storage self) internal view returns (bytes32) {
        return self.root;
    }
}

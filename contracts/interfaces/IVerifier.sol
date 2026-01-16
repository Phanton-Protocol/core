// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../types/Types.sol";

/**
 * @title IVerifier
 * @notice Interface for ZK-SNARK verifier contract
 * @dev Can be Groth16 or Plonk verifier
 */
interface IVerifier {
    /**
     * @notice Verifies a ZK-SNARK proof
     * @param proof The proof to verify
     * @param publicInputs The public inputs for verification
     * @return valid True if proof is valid, false otherwise
     */
    function verifyProof(
        Proof calldata proof,
        uint256[] calldata publicInputs
    ) external view returns (bool valid);
}

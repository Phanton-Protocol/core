// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IVerifier.sol";

interface IGroth16Verifier {
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[10] calldata _pubSignals
    ) external view returns (bool);
}

contract Groth16VerifierAdapter is IVerifier {
    IGroth16Verifier public immutable groth16;

    constructor(address _groth16) {
        require(_groth16 != address(0), "VerifierAdapter: zero verifier");
        groth16 = IGroth16Verifier(_groth16);
    }

    function verifyProof(
        Proof calldata proof,
        uint256[] calldata publicInputs
    ) external view override returns (bool) {
        require(publicInputs.length == 10, "VerifierAdapter: invalid public inputs");
        uint256[2] memory a = abi.decode(proof.a, (uint256[2]));
        uint256[2][2] memory b = abi.decode(proof.b, (uint256[2][2]));
        uint256[2] memory c = abi.decode(proof.c, (uint256[2]));
        uint256[10] memory inputs;
        for (uint256 i = 0; i < 10; i++) {
            inputs[i] = publicInputs[i];
        }
        return groth16.verifyProof(a, b, c, inputs);
    }
}

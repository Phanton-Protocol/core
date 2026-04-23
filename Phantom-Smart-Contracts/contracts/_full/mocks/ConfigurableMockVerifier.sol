// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IVerifier.sol";

contract ConfigurableMockVerifier is IVerifier {
    bool public isValid = true;

    function setValid(bool v) external {
        isValid = v;
    }

    function verifyProof(
        Proof calldata,
        uint256[] calldata
    ) external view override returns (bool) {
        return isValid;
    }
}

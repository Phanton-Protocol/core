// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "../interfaces/IShieldedPool.sol";
import "../interfaces/IVerifier.sol";
import "../interfaces/IFeeOracle.sol";
import "../interfaces/IRelayerRegistry.sol";
import "../types/Types.sol";
import "../libraries/MiMC7.sol";
import "../libraries/ProtocolFeeMath.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title WithdrawHandler
 * @notice External contract to handle withdraw operations and reduce main contract size
 * @dev **Module 2:** `nonReentrant` on `processWithdraw`.
 *      **Module 3:** Fees via {IFeeOracle.calculateFee} + {ProtocolFeeMath} (exact match, no 1% slack).
 */
contract WithdrawHandler is ReentrancyGuard {
    IShieldedPool public immutable shieldedPool;
    IVerifier public immutable verifier;
    IVerifier public immutable thresholdVerifier;
    IFeeOracle public immutable feeOracle;
    IRelayerRegistry public immutable relayerRegistry;

    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    modifier onlyShieldedPool() {
        require(msg.sender == address(shieldedPool), "WithdrawHandler: only ShieldedPool");
        _;
    }

    constructor(
        address _shieldedPool,
        address _verifier,
        address _thresholdVerifier,
        address _feeOracle,
        address _relayerRegistry
    ) {
        shieldedPool = IShieldedPool(_shieldedPool);
        verifier = IVerifier(_verifier);
        thresholdVerifier = IVerifier(_thresholdVerifier);
        feeOracle = IFeeOracle(_feeOracle);
        relayerRegistry = IRelayerRegistry(_relayerRegistry);
    }

    function processWithdraw(
        ShieldedWithdrawData calldata withdrawData
    ) external onlyShieldedPool nonReentrant returns (uint256 withdrawAmount, uint256 protocolFee) {
        JoinSplitPublicInputs memory inputs = withdrawData.publicInputs;

        require(
            thresholdVerifier.verifyProof(withdrawData.proof, _joinSplitPublicInputsToArray(inputs)),
            "WithdrawHandler: insufficient validator consensus"
        );

        require(
            verifier.verifyProof(withdrawData.proof, _joinSplitPublicInputsToArray(inputs)),
            "WithdrawHandler: invalid proof"
        );

        require(inputs.outputCommitmentSwap == bytes32(0), "WithdrawHandler: swap commitment must be zero");
        require(inputs.outputAssetIDSwap == 0, "WithdrawHandler: swap asset ID must be zero");

        withdrawAmount = inputs.swapAmount;
        require(withdrawAmount > 0, "WithdrawHandler: zero withdraw amount");

        require(
            inputs.inputAmount == withdrawAmount + inputs.changeAmount + inputs.protocolFee + inputs.gasRefund,
            "WithdrawHandler: amount conservation violated"
        );
        require(inputs.changeAmount > 0, "WithdrawHandler: zero change amount");

        address inputToken = shieldedPool.assetRegistry(inputs.inputAssetID);
        if (inputToken != address(0)) {
            try feeOracle.requireFreshPrice(inputToken) {} catch {}
        }

        protocolFee = feeOracle.calculateFee(inputToken, inputs.inputAmount);
        ProtocolFeeMath.requireExactProtocolFee(inputs.protocolFee, protocolFee);

        ProtocolFeeMath.requireGasRefundBounded(inputs.gasRefund, inputs.inputAmount);
    }

    function _joinSplitPublicInputsToArray(JoinSplitPublicInputs memory inputs) private pure returns (uint256[] memory) {
        uint256[] memory publicInputs = new uint256[](10);
        uint256 r0 = MiMC7.mimc7(inputs.inputAssetID, inputs.outputAssetIDSwap);
        uint256 r1 = MiMC7.mimc7(r0, inputs.outputAssetIDChange);
        uint256 r2 = MiMC7.mimc7(r1, inputs.inputAmount);
        uint256 r3 = MiMC7.mimc7(r2, inputs.swapAmount);
        uint256 r4 = MiMC7.mimc7(r3, inputs.changeAmount);
        uint256 r5 = MiMC7.mimc7(r4, inputs.outputAmountSwap);
        uint256 r6 = MiMC7.mimc7(r5, inputs.minOutputAmountSwap);
        uint256 r7 = MiMC7.mimc7(r6, inputs.protocolFee);
        uint256 r8 = MiMC7.mimc7(r7, inputs.gasRefund);
        uint256 withdrawMode = inputs.outputCommitmentSwap == bytes32(0) ? 1 : 0;
        // Safe: SNARK_SCALAR_FIELD is the alt_bn128 scalar; commitments are reduced in-circuit.
        unchecked {
            publicInputs[0] = uint256(inputs.nullifier) % SNARK_SCALAR_FIELD;
            publicInputs[1] = uint256(inputs.inputCommitment) % SNARK_SCALAR_FIELD;
            publicInputs[2] = uint256(inputs.outputCommitmentSwap) % SNARK_SCALAR_FIELD;
            publicInputs[3] = uint256(inputs.outputCommitmentChange) % SNARK_SCALAR_FIELD;
            publicInputs[4] = uint256(inputs.merkleRoot) % SNARK_SCALAR_FIELD;
            publicInputs[5] = inputs.outputAmountSwap % SNARK_SCALAR_FIELD;
            publicInputs[6] = inputs.minOutputAmountSwap % SNARK_SCALAR_FIELD;
            publicInputs[7] = inputs.protocolFee % SNARK_SCALAR_FIELD;
            publicInputs[8] = inputs.gasRefund % SNARK_SCALAR_FIELD;
            publicInputs[9] = MiMC7.mimc7(r8, withdrawMode) % SNARK_SCALAR_FIELD;
        }
        return publicInputs;
    }
}

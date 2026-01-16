// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IShieldedPool.sol";
import "../interfaces/IVerifier.sol";
import "../interfaces/IPancakeSwapAdaptor.sol";
import "../interfaces/IFeeOracle.sol";
import "../interfaces/IRelayerRegistry.sol";
import "../interfaces/IFeeDistributor.sol";
import "../types/Types.sol";
import "../libraries/MerkleTree.sol";
import "../libraries/IncrementalMerkleTree.sol";

/**
 * @title ShieldedPool
 * @notice Main contract for the Shadow-DeFi Protocol - Multi-Asset ZK-Pool
 * @dev Implements UTXO-based privacy mixer with internal swap capabilities
 * 
 * SECURITY MODEL:
 * - Uses Pedersen Commitments to hide asset amounts and types
 * - Merkle Tree stores all active commitments
 * - Nullifier Tree prevents double-spending
 * - Only whitelisted relayers can submit transactions
 * - ZK-SNARK proofs verify all state transitions
 */
contract ShieldedPool is IShieldedPool {
    using MerkleTree for bytes32;
    using IncrementalMerkleTree for IncrementalMerkleTree.Tree;

    // ============ Constants ============
    uint256 public constant MAX_TREE_DEPTH = 10;
    uint256 public constant MAX_ASSETS = 256; // Support up to 256 different assets

    // ============ State Variables ============
    IVerifier public immutable verifier;
    IPancakeSwapAdaptor public immutable swapAdaptor;
    IFeeOracle public immutable feeOracle;
    IRelayerRegistry public immutable relayerRegistry;

    // Merkle Tree State
    IncrementalMerkleTree.Tree private tree;
    bytes32 public merkleRoot;
    uint256 public commitmentCount;
    mapping(uint256 => bytes32) public commitments; // commitment index => commitment hash

    // Nullifier Tracking (Prevents Double-Spending)
    mapping(bytes32 => bool) public nullifiers; // nullifier => used

    // Asset Registry
    mapping(uint256 => address) public assetRegistry; // assetID => token address
    mapping(address => uint256) public assetIDMap; // token address => assetID
    uint256 public nextAssetID;
    uint256 public constant SWAP_FEE_NUMERATOR = 5; // 0.005%
    uint256 public constant SWAP_FEE_DENOMINATOR = 100000;

    // ============ Events ============
    event Deposit(
        address indexed depositor,
        address indexed token,
        uint256 assetID,
        uint256 amount,
        bytes32 commitment,
        uint256 commitmentIndex
    );

    event ShieldedSwap(
        bytes32 indexed nullifier,
        bytes32 indexed inputCommitment,
        bytes32 indexed outputCommitment,
        uint256 inputAssetID,
        uint256 outputAssetID,
        uint256 inputAmount,
        uint256 outputAmount,
        address relayer
    );

    event ShieldedSwapJoinSplit(
        bytes32 indexed nullifier,
        bytes32 indexed inputCommitment,
        bytes32 indexed outputCommitmentSwap,
        bytes32 outputCommitmentChange,
        uint256 inputAssetID,
        uint256 outputAssetIDSwap,
        uint256 outputAssetIDChange,
        uint256 inputAmount,
        uint256 swapAmount,
        uint256 changeAmount,
        uint256 outputAmountSwap,
        address relayer
    );

    event ShieldedWithdraw(
        bytes32 indexed nullifier,
        bytes32 indexed inputCommitment,
        bytes32 indexed outputCommitmentChange,
        address recipient,
        uint256 inputAssetID,
        uint256 withdrawAmount,
        uint256 changeAmount,
        address relayer
    );

    event EncryptedPayload(
        bytes32 indexed nullifier,
        bytes payload
    );

    event CommitmentAdded(bytes32 indexed commitment, uint256 index);
    event NullifierMarked(bytes32 indexed nullifier);

    // ============ Modifiers ============
    modifier onlyRelayer() {
        require(
            relayerRegistry.isRelayer(msg.sender),
            "ShieldedPool: not a registered relayer"
        );
        _;
    }

    // ============ Constructor ============
    constructor(
        address _verifier,
        address _swapAdaptor,
        address _feeOracle,
        address _relayerRegistry
    ) {
        require(_verifier != address(0), "ShieldedPool: zero verifier");
        require(_swapAdaptor != address(0), "ShieldedPool: zero adaptor");
        require(_feeOracle != address(0), "ShieldedPool: zero oracle");
        require(_relayerRegistry != address(0), "ShieldedPool: zero registry");

        verifier = IVerifier(_verifier);
        swapAdaptor = IPancakeSwapAdaptor(_swapAdaptor);
        feeOracle = IFeeOracle(_feeOracle);
        relayerRegistry = IRelayerRegistry(_relayerRegistry);

        // Initialize incremental Merkle tree
        tree.init(MAX_TREE_DEPTH);
        merkleRoot = tree.getRoot();
        nextAssetID = 1; // 0 reserved for BNB
    }

    // ============ Public Functions ============

    /**
     * @notice Deposits tokens into the shielded pool
     * @dev Creates a commitment and adds it to the Merkle tree
     * @param token Token address to deposit (address(0) for BNB)
     * @param amount Amount to deposit
     * @param commitment The Pedersen commitment H(AssetID, Amount, BlindingFactor, OwnerPublicKey)
     * @param assetID Asset identifier (must match token or be registered)
     */
    function deposit(
        address token,
        uint256 amount,
        bytes32 commitment,
        uint256 assetID
    ) external payable override {
        _depositInternal(msg.sender, token, amount, commitment, assetID, msg.value);
    }

    function depositFor(
        address depositor,
        address token,
        uint256 amount,
        bytes32 commitment,
        uint256 assetID
    ) external override {
        require(depositor != address(0), "ShieldedPool: zero depositor");
        require(token != address(0), "ShieldedPool: relayed deposit ERC20 only");
        _depositInternal(depositor, token, amount, commitment, assetID, 0);
    }

    /**
     * @notice Relayer deposits BNB on behalf of user (shadow address flow)
     * @dev Enables private BNB deposits via relayer intermediary
     */
    function depositForBNB(
        address depositor,
        bytes32 commitment,
        uint256 assetID
    ) external payable {
        require(depositor != address(0), "ShieldedPool: zero depositor");
        require(msg.value > 0, "ShieldedPool: zero value");
        _depositInternal(depositor, address(0), msg.value, commitment, assetID, msg.value);
    }

    /**
     * @notice Executes a shielded swap within the pool
     * @dev This is the core function that enables private swaps
     * 
     * FLOW:
     * 1. Verify nullifier hasn't been used (anti-double-spend)
     * 2. Verify ZK-SNARK proof
     * 3. Verify Merkle root matches current state
     * 4. Calculate fees using oracle
     * 5. Execute swap via PancakeSwap
     * 6. Verify swap output matches proof
     * 7. Add new commitment to tree
     * 8. Mark nullifier as used
     * 9. Refund relayer
     */
    function shieldedSwap(
        ShieldedSwapData calldata swapData
    ) external override onlyRelayer {
        PublicInputs memory inputs = swapData.publicInputs;
        SwapParams memory params = swapData.swapParams;

        // ============ STEP 1: NULLIFIER CHECK ============
        require(!nullifiers[inputs.nullifier], "ShieldedPool: nullifier already used");
        
        // ============ STEP 2: PROOF VERIFICATION ============
        require(
            _verifyProof(swapData.proof, inputs),
            "ShieldedPool: invalid proof"
        );

        // ============ STEP 3: MERKLE ROOT VERIFICATION ============
        require(
            inputs.merkleRoot == merkleRoot,
            "ShieldedPool: merkle root mismatch"
        );

        // Verify input commitment exists in tree
        require(
            MerkleTree.verifyProof(
                inputs.inputCommitment,
                inputs.merkleRoot,
                _convertToBytes32Array(inputs.merklePath),
                inputs.merklePathIndices,
                MAX_TREE_DEPTH
            ),
            "ShieldedPool: invalid merkle proof"
        );

        // ============ STEP 4: FEE CALCULATION ============
        address inputToken = assetRegistry[inputs.inputAssetID];
        require(inputToken != address(0), "ShieldedPool: invalid input asset");
        feeOracle.requireFreshPrice(inputToken);
        
        uint256 protocolFee = feeOracle.calculateFee(inputToken, inputs.inputAmount);
        uint256 swapFee = _calculateSwapFee(inputs.inputAmount);
        uint256 gasRefund = inputs.gasRefund;
        
        // Verify fees match proof
        uint256 totalProtocolFee = protocolFee + swapFee;
        require(inputs.protocolFee == totalProtocolFee, "ShieldedPool: fee mismatch");
        require(inputs.gasRefund <= inputs.inputAmount, "ShieldedPool: invalid gas refund");

        // ============ STEP 5: EXECUTE SWAP ============
        uint256 swapInputAmount = inputs.inputAmount - totalProtocolFee - gasRefund;
        require(swapInputAmount > 0, "ShieldedPool: insufficient swap amount");

        // Prepare swap parameters
        SwapParams memory swapParams = SwapParams({
            tokenIn: inputToken,
            tokenOut: assetRegistry[inputs.outputAssetID],
            amountIn: swapInputAmount,
            minAmountOut: inputs.minOutputAmount,
            fee: params.fee,
            sqrtPriceLimitX96: params.sqrtPriceLimitX96,
            path: params.path
        });

        require(swapParams.tokenOut != address(0), "ShieldedPool: invalid output asset");

        // Execute swap (BNB handling)
        uint256 swapOutput;
        if (inputToken == address(0)) {
            swapOutput = swapAdaptor.executeSwap{value: swapInputAmount}(swapParams);
        } else {
            IERC20(inputToken).approve(address(swapAdaptor), swapInputAmount);
            swapOutput = swapAdaptor.executeSwap(swapParams);
        }

        // ============ STEP 6: VERIFY SWAP OUTPUT ============
        require(
            swapOutput >= inputs.minOutputAmount,
            "ShieldedPool: slippage exceeded"
        );
        require(
            swapOutput == inputs.outputAmount,
            "ShieldedPool: output amount mismatch"
        );

        // ============ STEP 7: UPDATE MERKLE TREE ============
        (uint256 newIndex, bytes32 newRoot) = tree.insert(inputs.outputCommitment);
        commitments[newIndex] = inputs.outputCommitment;
        merkleRoot = newRoot;
        commitmentCount = tree.nextIndex;

        // ============ STEP 8: MARK NULLIFIER ============
        nullifiers[inputs.nullifier] = true;

        // ============ STEP 9: RELAYER REFUND ============
        address relayer = swapData.relayer != address(0) ? swapData.relayer : msg.sender;
        
        // Send protocol fee to staking distributor
        if (totalProtocolFee > 0) {
            if (inputToken == address(0)) {
                IFeeDistributor(address(relayerRegistry)).distributeFee{value: totalProtocolFee}(address(0), totalProtocolFee);
            } else {
                IERC20(inputToken).approve(address(relayerRegistry), totalProtocolFee);
                IFeeDistributor(address(relayerRegistry)).distributeFee(inputToken, totalProtocolFee);
            }
        }
        // Send gas refund to relayer
        if (gasRefund > 0) {
            if (inputToken == address(0)) {
                payable(relayer).transfer(gasRefund);
            } else {
                IERC20(inputToken).transfer(relayer, gasRefund);
            }
        }

        emit ShieldedSwap(
            inputs.nullifier,
            inputs.inputCommitment,
            inputs.outputCommitment,
            inputs.inputAssetID,
            inputs.outputAssetID,
            inputs.inputAmount,
            inputs.outputAmount,
            relayer
        );
        emit NullifierMarked(inputs.nullifier);
        emit CommitmentAdded(inputs.outputCommitment, newIndex);
    }

    /**
     * @notice Executes a join-split shielded swap within the pool
     * @dev Spends 1 input note, swaps via PancakeSwap, creates 2 output notes (swap result + change)
     * 
     * CONSERVATION RULE: Input_Amount = Swap_Amount + Change_Amount + Protocol_Fee + Gas_Refund
     * 
     * Example: Swap 4 BNB from a 10 BNB note
     * - Input: 10 BNB note (nullifier burned)
     * - Swap: 4 BNB → USDT (via PancakeSwap)
     * - Output 1: USDT note (swap result) → Added to Merkle tree
     * - Output 2: 6 BNB note (change) → Added to Merkle tree
     * 
     * FLOW:
     * 1. Verify nullifier hasn't been used
     * 2. Verify ZK-SNARK proof (join-split circuit)
     * 3. Verify Merkle root matches current state
     * 4. Verify conservation: inputAmount == swapAmount + changeAmount + fees
     * 5. Calculate fees using oracle
     * 6. Execute swap via PancakeSwap (only swapAmount, not changeAmount)
     * 7. Verify swap output matches proof
     * 8. Add BOTH commitments to Merkle tree (swap result + change)
     * 9. Mark nullifier as used
     * 10. Refund relayer
     */
    function shieldedSwapJoinSplit(
        JoinSplitSwapData calldata swapData
    ) external override onlyRelayer {
        JoinSplitPublicInputs memory inputs = swapData.publicInputs;
        SwapParams memory params = swapData.swapParams;

        // ============ STEP 1: NULLIFIER CHECK ============
        require(!nullifiers[inputs.nullifier], "ShieldedPool: nullifier already used");
        
        // ============ STEP 2: PROOF VERIFICATION ============
        require(
            _verifyJoinSplitProof(swapData.proof, inputs),
            "ShieldedPool: invalid join-split proof"
        );

        // ============ STEP 3: MERKLE ROOT VERIFICATION ============
        require(
            inputs.merkleRoot == merkleRoot,
            "ShieldedPool: merkle root mismatch"
        );

        // Verify input commitment exists in tree
        require(
            MerkleTree.verifyProof(
                inputs.inputCommitment,
                inputs.merkleRoot,
                _convertToBytes32Array(inputs.merklePath),
                inputs.merklePathIndices,
                MAX_TREE_DEPTH
            ),
            "ShieldedPool: invalid merkle proof"
        );

        // ============ STEP 4: CONSERVATION VERIFICATION ============
        // Verify: Input_Amount = Swap_Amount + Change_Amount + Protocol_Fee + Gas_Refund
        uint256 totalOutput = inputs.swapAmount + inputs.changeAmount + inputs.protocolFee + inputs.gasRefund;
        require(
            inputs.inputAmount == totalOutput,
            "ShieldedPool: amount conservation violated"
        );

        // Verify change amount is non-zero (must have change for join-split)
        require(inputs.changeAmount > 0, "ShieldedPool: zero change amount");

        // ============ STEP 5: FEE CALCULATION ============
        address inputToken = assetRegistry[inputs.inputAssetID];
        require(inputToken != address(0), "ShieldedPool: invalid input asset");
        feeOracle.requireFreshPrice(inputToken);
        
        uint256 protocolFee = feeOracle.calculateFee(inputToken, inputs.inputAmount);
        uint256 swapFee = _calculateSwapFee(inputs.inputAmount);
        uint256 gasRefund = inputs.gasRefund;
        
        // Verify fees match proof
        uint256 totalProtocolFee = protocolFee + swapFee;
        require(inputs.protocolFee == totalProtocolFee, "ShieldedPool: fee mismatch");
        require(inputs.gasRefund <= inputs.inputAmount, "ShieldedPool: invalid gas refund");

        // ============ STEP 6: EXECUTE SWAP ============
        // Only swapAmount is sent to PancakeSwap, changeAmount stays in pool
        require(inputs.swapAmount > 0, "ShieldedPool: zero swap amount");

        // Prepare swap parameters
        SwapParams memory swapParams = SwapParams({
            tokenIn: inputToken,
            tokenOut: assetRegistry[inputs.outputAssetIDSwap],
            amountIn: inputs.swapAmount,
            minAmountOut: inputs.minOutputAmountSwap,
            fee: params.fee,
            sqrtPriceLimitX96: params.sqrtPriceLimitX96,
            path: params.path
        });

        require(swapParams.tokenOut != address(0), "ShieldedPool: invalid swap output asset");
        require(
            assetRegistry[inputs.outputAssetIDChange] == inputToken,
            "ShieldedPool: change asset must match input asset"
        );

        // Execute swap (BNB handling)
        uint256 swapOutput;
        if (inputToken == address(0)) {
            swapOutput = swapAdaptor.executeSwap{value: inputs.swapAmount}(swapParams);
        } else {
            IERC20(inputToken).approve(address(swapAdaptor), inputs.swapAmount);
            swapOutput = swapAdaptor.executeSwap(swapParams);
        }

        // ============ STEP 7: VERIFY SWAP OUTPUT ============
        require(
            swapOutput >= inputs.minOutputAmountSwap,
            "ShieldedPool: slippage exceeded"
        );
        require(
            swapOutput == inputs.outputAmountSwap,
            "ShieldedPool: swap output amount mismatch"
        );

        // ============ STEP 8: UPDATE MERKLE TREE (DUAL COMMITMENTS) ============
        // Add swap result commitment
        (uint256 swapIndex, bytes32 swapRoot) = tree.insert(inputs.outputCommitmentSwap);
        commitments[swapIndex] = inputs.outputCommitmentSwap;
        merkleRoot = swapRoot;
        commitmentCount = tree.nextIndex;

        // Add change commitment
        (uint256 changeIndex, bytes32 changeRoot) = tree.insert(inputs.outputCommitmentChange);
        commitments[changeIndex] = inputs.outputCommitmentChange;
        merkleRoot = changeRoot;
        commitmentCount = tree.nextIndex;

        // ============ STEP 9: MARK NULLIFIER ============
        nullifiers[inputs.nullifier] = true;

        // ============ STEP 10: RELAYER REFUND ============
        address relayer = swapData.relayer != address(0) ? swapData.relayer : msg.sender;
        
        // Send protocol fee to staking distributor
        if (totalProtocolFee > 0) {
            if (inputToken == address(0)) {
                IFeeDistributor(address(relayerRegistry)).distributeFee{value: totalProtocolFee}(address(0), totalProtocolFee);
            } else {
                IERC20(inputToken).approve(address(relayerRegistry), totalProtocolFee);
                IFeeDistributor(address(relayerRegistry)).distributeFee(inputToken, totalProtocolFee);
            }
        }
        // Send gas refund to relayer
        if (gasRefund > 0) {
            if (inputToken == address(0)) {
                payable(relayer).transfer(gasRefund);
            } else {
                IERC20(inputToken).transfer(relayer, gasRefund);
            }
        }

        emit ShieldedSwapJoinSplit(
            inputs.nullifier,
            inputs.inputCommitment,
            inputs.outputCommitmentSwap,
            inputs.outputCommitmentChange,
            inputs.inputAssetID,
            inputs.outputAssetIDSwap,
            inputs.outputAssetIDChange,
            inputs.inputAmount,
            inputs.swapAmount,
            inputs.changeAmount,
            inputs.outputAmountSwap,
            relayer
        );
        emit NullifierMarked(inputs.nullifier);
        emit CommitmentAdded(inputs.outputCommitmentSwap, swapIndex);
        emit CommitmentAdded(inputs.outputCommitmentChange, changeIndex);

        if (swapData.encryptedPayload.length > 0) {
            emit EncryptedPayload(inputs.nullifier, swapData.encryptedPayload);
        }
    }

    /**
     * @notice Executes a shielded withdrawal from the pool
     * @dev Spends 1 input note, withdraws to external address, creates 1 change note
     * 
     * CONSERVATION RULE: Input_Amount = Withdraw_Amount + Change_Amount + Protocol_Fee + Gas_Refund
     * 
     * Example: Withdraw 2 BNB from a 10 BNB note
     * - Input: 10 BNB note (nullifier burned)
     * - Withdraw: 2 BNB sent to recipient address
     * - Output: 8 BNB note (change) → Added to Merkle tree
     * 
     * FLOW:
     * 1. Verify nullifier hasn't been used
     * 2. Verify ZK-SNARK proof (join-split circuit, outputCommitmentSwap = zero)
     * 3. Verify Merkle root matches current state
     * 4. Verify conservation: inputAmount == withdrawAmount + changeAmount + fees
     * 5. Calculate fees using oracle
     * 6. Transfer withdraw amount to recipient
     * 7. Add change commitment to Merkle tree
     * 8. Mark nullifier as used
     * 9. Refund relayer
     */
    function shieldedWithdraw(
        ShieldedWithdrawData calldata withdrawData
    ) external override onlyRelayer {
        JoinSplitPublicInputs memory inputs = withdrawData.publicInputs;
        address recipient = withdrawData.recipient;

        require(recipient != address(0), "ShieldedPool: zero recipient");

        // ============ STEP 1: NULLIFIER CHECK ============
        require(!nullifiers[inputs.nullifier], "ShieldedPool: nullifier already used");
        
        // ============ STEP 2: PROOF VERIFICATION ============
        require(
            _verifyJoinSplitProof(withdrawData.proof, inputs),
            "ShieldedPool: invalid join-split proof"
        );

        // ============ STEP 3: MERKLE ROOT VERIFICATION ============
        require(
            inputs.merkleRoot == merkleRoot,
            "ShieldedPool: merkle root mismatch"
        );

        // Verify input commitment exists in tree
        require(
            MerkleTree.verifyProof(
                inputs.inputCommitment,
                inputs.merkleRoot,
                _convertToBytes32Array(inputs.merklePath),
                inputs.merklePathIndices,
                MAX_TREE_DEPTH
            ),
            "ShieldedPool: invalid merkle proof"
        );

        // ============ STEP 4: CONSERVATION VERIFICATION ============
        // For withdrawal: Input_Amount = Withdraw_Amount + Change_Amount + Protocol_Fee + Gas_Refund
        // outputCommitmentSwap should be zero (no swap output)
        require(
            inputs.outputCommitmentSwap == bytes32(0),
            "ShieldedPool: swap commitment must be zero for withdrawal"
        );
        require(
            inputs.outputAssetIDSwap == 0,
            "ShieldedPool: swap asset ID must be zero for withdrawal"
        );

        // Withdraw amount = swapAmount (repurposed for withdrawal)
        uint256 withdrawAmount = inputs.swapAmount;
        require(withdrawAmount > 0, "ShieldedPool: zero withdraw amount");

        uint256 totalOutput = withdrawAmount + inputs.changeAmount + inputs.protocolFee + inputs.gasRefund;
        require(
            inputs.inputAmount == totalOutput,
            "ShieldedPool: amount conservation violated"
        );

        // Verify change amount is non-zero
        require(inputs.changeAmount > 0, "ShieldedPool: zero change amount");

        // ============ STEP 5: FEE CALCULATION ============
        address inputToken = assetRegistry[inputs.inputAssetID];
        require(inputToken != address(0), "ShieldedPool: invalid input asset");
        feeOracle.requireFreshPrice(inputToken);
        
        uint256 protocolFee = feeOracle.calculateFee(inputToken, inputs.inputAmount);
        uint256 gasRefund = inputs.gasRefund;
        
        // Verify fees match proof
        require(inputs.protocolFee == protocolFee, "ShieldedPool: fee mismatch");
        require(inputs.gasRefund <= inputs.inputAmount, "ShieldedPool: invalid gas refund");

        // ============ STEP 6: TRANSFER TO RECIPIENT ============
        // Transfer withdraw amount to recipient
        if (inputToken == address(0)) {
            payable(recipient).transfer(withdrawAmount);
        } else {
            IERC20(inputToken).transfer(recipient, withdrawAmount);
        }

        // ============ STEP 7: UPDATE MERKLE TREE (CHANGE COMMITMENT) ============
        (uint256 changeIndex, bytes32 changeRoot) = tree.insert(inputs.outputCommitmentChange);
        commitments[changeIndex] = inputs.outputCommitmentChange;
        merkleRoot = changeRoot;
        commitmentCount = tree.nextIndex;

        // ============ STEP 8: MARK NULLIFIER ============
        nullifiers[inputs.nullifier] = true;

        // ============ STEP 9: RELAYER REFUND ============
        address relayer = withdrawData.relayer != address(0) ? withdrawData.relayer : msg.sender;
        
        if (protocolFee > 0) {
            if (inputToken == address(0)) {
                IFeeDistributor(address(relayerRegistry)).distributeFee{value: protocolFee}(address(0), protocolFee);
            } else {
                IERC20(inputToken).approve(address(relayerRegistry), protocolFee);
                IFeeDistributor(address(relayerRegistry)).distributeFee(inputToken, protocolFee);
            }
        }
        // Send gas refund to relayer
        if (gasRefund > 0) {
            if (inputToken == address(0)) {
                payable(relayer).transfer(gasRefund);
            } else {
                IERC20(inputToken).transfer(relayer, gasRefund);
            }
        }

        emit ShieldedWithdraw(
            inputs.nullifier,
            inputs.inputCommitment,
            inputs.outputCommitmentChange,
            recipient,
            inputs.inputAssetID,
            withdrawAmount,
            inputs.changeAmount,
            relayer
        );
        emit NullifierMarked(inputs.nullifier);
        emit CommitmentAdded(inputs.outputCommitmentChange, changeIndex);

        if (withdrawData.encryptedPayload.length > 0) {
            emit EncryptedPayload(inputs.nullifier, withdrawData.encryptedPayload);
        }
    }

    // ============ View Functions ============

    /**
     * @notice Gets the current Merkle root
     */
    function getMerkleRoot() external view override returns (bytes32) {
        return merkleRoot;
    }

    /**
     * @notice Checks if a nullifier has been used
     */
    function isNullifierUsed(bytes32 nullifier) external view override returns (bool) {
        return nullifiers[nullifier];
    }

    /**
     * @notice Gets the total number of commitments
     */
    function getCommitmentCount() external view override returns (uint256) {
        return commitmentCount;
    }

    // ============ Internal Functions ============

    /**
     * @notice Verifies a ZK-SNARK proof (Legacy - single output)
     * @dev Converts PublicInputs to array format for verifier
     */
    function _verifyProof(
        Proof memory,
        PublicInputs memory
    ) internal view returns (bool) {
        return false;
    }

    /**
     * @notice Verifies a join-split ZK-SNARK proof (1 input, 2 outputs)
     * @dev Converts JoinSplitPublicInputs to array format for verifier
     */
    function _verifyJoinSplitProof(
        Proof memory proof,
        JoinSplitPublicInputs memory inputs
    ) internal view returns (bool) {
        // Circuit expects: nullifier, inputCommitment, outputCommitmentSwap, outputCommitmentChange,
        // merkleRoot, outputAmountSwapPublic, minOutputAmountSwap, protocolFee, gasRefund,
        // merklePath[10], merklePathIndices[10]
        uint256[] memory publicInputsArray = new uint256[](29);
        publicInputsArray[0] = uint256(inputs.nullifier);
        publicInputsArray[1] = uint256(inputs.inputCommitment);
        publicInputsArray[2] = uint256(inputs.outputCommitmentSwap);
        publicInputsArray[3] = uint256(inputs.outputCommitmentChange);
        publicInputsArray[4] = uint256(inputs.merkleRoot);
        publicInputsArray[5] = inputs.outputAmountSwap;
        publicInputsArray[6] = inputs.minOutputAmountSwap;
        publicInputsArray[7] = inputs.protocolFee;
        publicInputsArray[8] = inputs.gasRefund;
        for (uint256 i = 0; i < 10; i++) {
            publicInputsArray[9 + i] = inputs.merklePath[i];
            publicInputsArray[19 + i] = inputs.merklePathIndices[i];
        }

        return verifier.verifyProof(proof, publicInputsArray);
    }

    /**
     * @notice Converts uint256 array to bytes32 array
     */
    function _convertToBytes32Array(uint256[10] memory arr) internal pure returns (bytes32[10] memory) {
        bytes32[10] memory result;
        for (uint256 i = 0; i < 10; i++) {
            result[i] = bytes32(arr[i]);
        }
        return result;
    }

    function _calculateDepositFee(address token, uint256 amount) internal view returns (uint256) {
        uint256 usdValue;
        try feeOracle.getUSDValue(token, amount) returns (uint256 v) {
            usdValue = v;
        } catch {
            return 0;
        }
        if (usdValue == 0) {
            return 0;
        }
        uint256 floorUsd = 10 * 1e8;
        uint256 rand = uint256(keccak256(abi.encodePacked(block.prevrandao, msg.sender, amount))) % 41; // 0..40
        uint256 bps = 10 + rand; // 10..50 bps => 0.1%..0.5%
        uint256 percentUsd = (usdValue * bps) / 10000;
        uint256 feeUsd = percentUsd > floorUsd ? percentUsd : floorUsd;
        uint256 tokenDecimals = token == address(0) ? 18 : 18;
        uint256 fee = (feeUsd * (10 ** tokenDecimals)) / (10 ** 8);
        if (fee > amount) return amount;
        return fee;
    }

    function _depositInternal(
        address depositor,
        address token,
        uint256 amount,
        bytes32 commitment,
        uint256 assetID,
        uint256 value
    ) internal {
        require(amount > 0, "ShieldedPool: zero amount");
        require(commitment != bytes32(0), "ShieldedPool: zero commitment");

        // Register asset if not already registered
        if (assetID == 0) {
            require(token == address(0), "ShieldedPool: assetID 0 reserved for BNB");
        } else {
            if (assetRegistry[assetID] == address(0)) {
                require(token != address(0), "ShieldedPool: invalid token");
                assetRegistry[assetID] = token;
                assetIDMap[token] = assetID;
            } else {
                require(assetRegistry[assetID] == token, "ShieldedPool: assetID mismatch");
            }
        }

        // Transfer tokens (or BNB)
        if (token == address(0)) {
            // Allow shadow deposits: depositor can be different from msg.sender (relayer)
            require(value >= amount, "ShieldedPool: insufficient BNB");
        } else {
            require(value == 0, "ShieldedPool: BNB not needed");
            // For ERC20: If depositor == msg.sender (direct), pull from depositor
            // If depositor != msg.sender (relayed), pull from depositor (requires pre-approval)
            IERC20(token).transferFrom(depositor, address(this), amount);
        }

        // Apply deposit fee (min $10 or 0.1%-0.5%, whichever higher)
        feeOracle.requireFreshPrice(token);
        uint256 fee = _calculateDepositFee(token, amount);
        require(amount > fee, "ShieldedPool: fee exceeds amount");

        if (fee > 0) {
            if (token == address(0)) {
                IFeeDistributor(address(relayerRegistry)).distributeFee{value: fee}(address(0), fee);
            } else {
                IERC20(token).approve(address(relayerRegistry), fee);
                IFeeDistributor(address(relayerRegistry)).distributeFee(token, fee);
            }
        }

        // Add commitment to tree (user commitment should represent net amount)
        (uint256 index, bytes32 newRoot) = tree.insert(commitment);
        commitments[index] = commitment;
        merkleRoot = newRoot;
        commitmentCount = tree.nextIndex;

        emit Deposit(depositor, token, assetID, amount, commitment, index);
        emit CommitmentAdded(commitment, index);
    }

    function _calculateSwapFee(uint256 amount) internal pure returns (uint256) {
        return (amount * SWAP_FEE_NUMERATOR) / SWAP_FEE_DENOMINATOR;
    }
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

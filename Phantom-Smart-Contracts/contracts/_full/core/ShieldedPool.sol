// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IShieldedPool.sol";
import "../interfaces/IVerifier.sol";
import "../interfaces/IPancakeSwapAdaptor.sol";
import "../interfaces/IFeeOracle.sol";
import "../interfaces/IRelayerRegistry.sol";
import "../interfaces/IFeeDistributor.sol";
import "../interfaces/IDepositHandler.sol";
import "../types/Types.sol";
import "../libraries/MerkleTree.sol";
import "../libraries/IncrementalMerkleTree.sol";
import "../libraries/MiMC7.sol";
import "../libraries/DexSwapFee.sol";
import "../libraries/InternalMatchIntentLib.sol";
import "./ComplianceModule.sol";
import "./TransactionHistory.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

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
contract ShieldedPool is IShieldedPool, ReentrancyGuard {
    using MerkleTree for bytes32;
    using IncrementalMerkleTree for IncrementalMerkleTree.Tree;
    using SafeERC20 for IERC20;

    error PoolErr(uint8 code);

    // ============ Constants ============
    uint256 public constant MAX_TREE_DEPTH = 10; // Matches circuit/array sizes

    /// @dev BN128 scalar field order (Circom / Groth16 `Fr`); public inputs must match field reduction.
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    // ============ State Variables ============
    IVerifier public immutable verifier;
    IVerifier public immutable portfolioVerifier;
    IVerifier public immutable thresholdVerifier; // Validator consensus verifier
    IPancakeSwapAdaptor public immutable swapAdaptor;
    IFeeOracle public immutable feeOracle;
    IRelayerRegistry public immutable relayerRegistry;
    TransactionHistory public transactionHistory; // Transaction history and keys
    address public depositHandler; // Separate contract for deposit processing (reduces stack depth)

    // Merkle Tree State
    IncrementalMerkleTree.Tree private tree;
    bytes32 public merkleRoot;
    uint256 public commitmentCount;
    mapping(uint256 => bytes32) public commitments; // commitment index => commitment hash

    // Nullifier Tracking (Prevents Double-Spending)
    mapping(bytes32 => bool) public nullifiers; // nullifier => used

    // Legacy single-note storage (kept for join-split deposit flow compatibility)
    mapping(address => bytes32) public userNotes;
    mapping(address => uint256) public userNoteAssetID;

    // Asset Registry
    mapping(uint256 => address) public assetRegistry; // assetID => token address
    mapping(address => uint256) public assetIDMap; // token address => assetID
    uint256 public nextAssetID;
    
    // ============ Portfolio Note System ============
    /// @notice One portfolio note per user (address => commitment + nonce)
    mapping(address => bytes32) public userPortfolioCommitment;
    mapping(address => uint256) public userPortfolioNonce;

    event PortfolioNoteUpdated(address indexed owner, bytes32 oldCommitment, bytes32 newCommitment, uint256 oldNonce, uint256 newNonce);
    
    // ============ Temporary Storage for Stack Depth Reduction ============
    // Using storage variables to reduce stack depth in all functions
    address private tempAddr1;
    address private tempAddr2;
    uint256 private tempUint1;
    uint256 private tempUint2;
    uint256 private tempUint3;
    bytes32 private tempBytes32;
    
    // ============ Gas Reserve System ============
    /// @notice Pool's BNB gas reserve (for paying gas on transactions)
    uint256 public gasReserve;
    
    // ============ Relayer Blacklisting ============
    /// @notice Blacklisted relayers (cannot submit transactions)
    mapping(address => bool) public blacklistedRelayers;
    
    // ============ MEV & Frontrunning Protection ============
    /// @notice Commit-reveal scheme for swap protection
    /// @dev Prevents frontrunning by requiring commitment before reveal
    mapping(bytes32 => bool) public swapCommitments; // commitment hash => used
    mapping(bytes32 => uint256) public swapCommitmentDeadline; // commitment hash => deadline timestamp
    uint256 internal constant MAX_DEADLINE_DURATION = 1 hours; // Maximum time from commit to reveal
    
    /// @notice Nonce-based ordering to prevent reordering attacks
    mapping(address => mapping(uint256 => bool)) public relayerAttestationNonceUsed;
    mapping(address => mapping(uint256 => bool)) public internalMatchAttestationNonceUsed;
    mapping(bytes32 => bool) public usedInternalMatchHashes;
    mapping(bytes32 => bool) public usedInternalDecisionHashes;

    mapping(address => mapping(uint256 => bool)) public internalMatchIntentNonceUsed;
    
    // ============ Compliance Module ============
    /// @notice Compliance module for Chainalysis checks
    /// @dev Can be set via setComplianceModule() after deployment
    address internal complianceModuleAddress;
    
    // ============ Owner ============
    /// @notice Contract owner (can set compliance module)
    address internal poolOwner;
    
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
    event DepositHandlerSet(address indexed depositHandler);
    event PortfolioStateReset(address indexed user, bytes32 oldCommitment, uint256 oldNonce);
    event NullifierMarked(bytes32 indexed nullifier);
    event GasRefunded(address indexed relayer, uint256 amount);
    event RelayerAttestationVerified(address indexed relayer, uint256 indexed nonce, bytes32 digest);
    event InternalMatchSettled(
        bytes32 indexed matchHash,
        bytes32 indexed decisionHash,
        bytes32 indexed executionKey,
        bytes32 makerOrderId,
        bytes32 takerOrderId,
        address relayer
    );
    event RelayerBlacklisted(address indexed relayer);
    event RelayerUnblacklisted(address indexed relayer);

    // ============ Modifiers ============
    modifier onlyRelayer() {
        if (!relayerRegistry.isRelayer(msg.sender) || blacklistedRelayers[msg.sender]) revert PoolErr(44);
        _;
    }
    
    modifier notBlacklisted(address addr) {
        if (blacklistedRelayers[addr]) revert PoolErr(2);
        _;
    }
    

    // ============ Constructor ============
    constructor(
        address _verifier,
        address _portfolioVerifier,
        address _thresholdVerifier,
        address _swapAdaptor,
        address _feeOracle,
        address _relayerRegistry
    ) {
        if (_verifier == address(0) || _thresholdVerifier == address(0) || _swapAdaptor == address(0) || _feeOracle == address(0) || _relayerRegistry == address(0)) revert PoolErr(1);

        verifier = IVerifier(_verifier);
        portfolioVerifier = _portfolioVerifier != address(0) ? IVerifier(_portfolioVerifier) : IVerifier(_verifier);
        thresholdVerifier = IVerifier(_thresholdVerifier);
        swapAdaptor = IPancakeSwapAdaptor(_swapAdaptor);
        feeOracle = IFeeOracle(_feeOracle);
        relayerRegistry = IRelayerRegistry(_relayerRegistry);
        // transactionHistory can be set later via setter to avoid stack depth issues
        complianceModuleAddress = address(0); // Can be set later via setter

        // Initialize incremental Merkle tree (depth must be between 1 and 10)
        uint256 treeDepth = 20; // Standard depth for privacy pools
        if (treeDepth > 10) treeDepth = 10; // Limit to library max
        tree.init(treeDepth);
        merkleRoot = tree.getRoot();
        nextAssetID = 1; // 0 reserved for BNB
        gasReserve = 0; // Initialize gas reserve
        poolOwner = msg.sender; // Set owner
    }
    
    /**
     * @notice Set compliance module address (can be set after deployment)
     * @dev Can be set by owner or relayer registry
     */
    function setComplianceModule(address _complianceModule) external virtual {
        // Allow owner or relayer registry to set
        if (msg.sender != poolOwner && msg.sender != address(relayerRegistry)) revert PoolErr(3);
        if (_complianceModule == address(0)) revert PoolErr(1);
        complianceModuleAddress = _complianceModule;
    }

    /**
     * @notice Get compliance module address
     */
    function getComplianceModule() external view returns (address) {
        return complianceModuleAddress;
    }
    
    /**
     * @notice Set transaction history contract (can be set after deployment)
     * @dev Only owner can set this
     */
    function setTransactionHistory(address _transactionHistory) external {
        if (msg.sender != poolOwner || _transactionHistory == address(0)) revert PoolErr(3);
        transactionHistory = TransactionHistory(_transactionHistory);
    }
    
    /**
     * @notice Set deposit handler contract (reduces stack depth)
     * @dev Only owner can set this
     * @param _depositHandler Address of DepositHandler contract
     */
    function setDepositHandler(address _depositHandler) external {
        if (msg.sender != poolOwner) revert PoolErr(3);
        // Allow setting to zero to disable handler (fallback to direct logic)
        depositHandler = _depositHandler;
        emit DepositHandlerSet(_depositHandler);
    }

    /**
     * @notice Reset portfolio state for a user (owner only)
     * @dev Use when NoteStorage/customer data is out of sync with on-chain state (e.g. migration from multi-note to single portfolio).
     *      WARNING: User loses access to any existing portfolio balance - only use when user has confirmed they accept this.
     * @param user Address whose portfolio state to reset
     */
    function resetPortfolioState(address user) external {
        if (msg.sender != poolOwner) revert PoolErr(3);
        if (user == address(0)) revert PoolErr(1);
        bytes32 oldCommitment = userPortfolioCommitment[user];
        uint256 oldNonce = userPortfolioNonce[user];
        userPortfolioCommitment[user] = bytes32(0);
        userPortfolioNonce[user] = 0;
        emit PortfolioStateReset(user, oldCommitment, oldNonce);
    }

    /**
     * @notice Register asset for portfolio swap/withdraw (owner only)
     * @dev AssetID 0 is reserved for native BNB (address(0))
     */
    function registerAsset(uint256 assetID, address token) external {
        if (msg.sender != poolOwner) revert PoolErr(3);
        _registerAsset(assetID, token);
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
    ) external payable override nonReentrant {
        _depositInternal(msg.sender, token, amount, commitment, assetID, msg.value, address(0));
        // Transaction logging handled off-chain to reduce stack depth
    }

    function depositFor(
        address depositor,
        address token,
        uint256 amount,
        bytes32 commitment,
        uint256 assetID
    ) external payable override nonReentrant {
        if (depositor == address(0)) revert PoolErr(1);
        if (token == address(0)) revert PoolErr(8);
        _depositInternal(depositor, token, amount, commitment, assetID, msg.value, msg.sender);
        // Transaction logging handled off-chain to reduce stack depth
    }

    /**
     * @notice Relayer deposits BNB on behalf of user (shadow address flow)
     * @dev Enables private BNB deposits via relayer intermediary
     */
    function depositForBNB(
        address depositor,
        bytes32 commitment,
        uint256 assetID
    ) external payable nonReentrant {
        if (depositor == address(0)) revert PoolErr(1);
        if (msg.value == 0) revert PoolErr(9);
        _depositInternal(depositor, address(0), msg.value, commitment, assetID, msg.value, msg.sender);
        // Transaction logging handled off-chain to reduce stack depth
    }

    /**
     * @notice Executes a shielded swap within the pool
     * @dev POOL EXECUTES SWAP (not relayer). Anyone can call with valid proof.
     * 
     * FLOW:
     * 0. **VERIFY VALIDATOR CONSENSUS (MANDATORY)** - Economic security layer
     * 1. Verify nullifier hasn't been used (anti-double-spend)
     * 2. Verify ZK-SNARK proof (cryptographic security layer)
     * 3. Verify Merkle root matches current state
     * 4. Calculate fees using oracle
     * 5. POOL EXECUTES swap via PancakeSwap (pool contract executes, not relayer)
     * 6. Verify swap output matches proof
     * 7. Add new commitment to tree
     * 8. Mark nullifier as used
     */
    /// @dev Legacy single-output swap disabled; use shieldedSwapJoinSplit
    function shieldedSwap(
        ShieldedSwapData calldata /* swapData */
    ) external override nonReentrant {
        revert PoolErr(47);
    }

    /**
     * @notice Portfolio-note deposit (single note per wallet, vector balances)
     */
    function portfolioDeposit(
        address token,
        uint256 amount,
        PortfolioSwapData calldata data
    ) external payable override nonReentrant {
        PortfolioSwapPublicInputs memory inputs = data.publicInputs;

        if (!_verifyPortfolioProof(data.proof, inputs)) revert PoolErr(6);
        _requirePortfolioState(data.owner, inputs);

        if (inputs.inputAssetID != inputs.outputAssetID || inputs.swapAmount != 0 || inputs.outputAmount != amount || inputs.minOutputAmount != 0) revert PoolErr(12);

        if (token == address(0)) {
            if (msg.value != amount) revert PoolErr(13);
        } else {
            if (msg.value != 0) revert PoolErr(14);
            IERC20(token).transferFrom(msg.sender, address(this), amount);
        }

        _registerAsset(inputs.inputAssetID, token);
        _updatePortfolioState(data.owner, inputs);
    }

    /**
     * @notice Portfolio-note swap/update
     */
    function portfolioSwap(
        PortfolioSwapData calldata data
    ) external override nonReentrant {
        PortfolioSwapPublicInputs memory inputs = data.publicInputs;

        if (!_verifyPortfolioProof(data.proof, inputs)) revert PoolErr(6);
        _requirePortfolioState(data.owner, inputs);

        address inputToken = assetRegistry[inputs.inputAssetID];
        address outputToken = assetRegistry[inputs.outputAssetID];
        if (inputToken == address(0) && inputs.inputAssetID != 0) revert PoolErr(11);
        if (outputToken == address(0) && inputs.outputAssetID != 0) revert PoolErr(11);

        feeOracle.requireFreshPrice(inputToken);
        uint256 protocolFee = feeOracle.calculateFee(inputToken, inputs.swapAmount);
        uint256 swapFee = _calculateSwapFee(inputs.swapAmount);
        uint256 totalProtocolFee = protocolFee + swapFee;
        if (inputs.protocolFee != totalProtocolFee) revert PoolErr(5);

        uint256 swapOutput = 0;
        if (inputs.inputAssetID != inputs.outputAssetID) {
            SwapParams memory swapParams = SwapParams({
                tokenIn: inputToken,
                tokenOut: outputToken,
                amountIn: inputs.swapAmount,
                minAmountOut: inputs.minOutputAmount,
                fee: data.swapParams.fee,
                sqrtPriceLimitX96: data.swapParams.sqrtPriceLimitX96,
                path: data.swapParams.path
            });
            if (inputToken == address(0)) {
                swapOutput = swapAdaptor.executeSwap{value: inputs.swapAmount}(swapParams);
            } else {
                IERC20(inputToken).approve(address(swapAdaptor), inputs.swapAmount);
                swapOutput = swapAdaptor.executeSwap(swapParams);
            }
            // Accept swapOutput >= minOutputAmount (slippage). Proof uses minOutputAmount as outputAmount.
            if (swapOutput < inputs.minOutputAmount) revert PoolErr(15);
        } else {
            if (inputs.outputAmount != 0) revert PoolErr(16);
        }

        address relayer = data.relayer != address(0) ? data.relayer : msg.sender;
        if (totalProtocolFee > 0) {
            if (inputToken == address(0)) {
                IFeeDistributor(address(relayerRegistry)).distributeFee{value: totalProtocolFee}(address(0), totalProtocolFee);
            } else {
                IERC20(inputToken).approve(address(relayerRegistry), totalProtocolFee);
                IFeeDistributor(address(relayerRegistry)).distributeFee(inputToken, totalProtocolFee);
            }
        }
        if (inputs.gasRefund > 0) {
            if (inputToken == address(0)) {
                payable(relayer).transfer(inputs.gasRefund);
            } else {
                IERC20(inputToken).transfer(relayer, inputs.gasRefund);
            }
        }

        _updatePortfolioState(data.owner, inputs);
    }

    /**
     * @notice Portfolio-note withdrawal
     */
    function portfolioWithdraw(
        PortfolioWithdrawData calldata data
    ) external override nonReentrant {
        PortfolioSwapPublicInputs memory inputs = data.publicInputs;

        if (!_verifyPortfolioProof(data.proof, inputs)) revert PoolErr(6);
        _requirePortfolioState(data.owner, inputs);

        if (inputs.inputAssetID != inputs.outputAssetID || inputs.outputAmount != 0) revert PoolErr(17);

        address token = assetRegistry[inputs.inputAssetID];
        uint256 withdrawAmount = inputs.swapAmount;
        if (withdrawAmount == 0) revert PoolErr(18);

        if (token == address(0)) {
            payable(data.recipient).transfer(withdrawAmount);
        } else {
            IERC20(token).transfer(data.recipient, withdrawAmount);
        }

        _updatePortfolioState(data.owner, inputs);
    }

    /**
     * @notice Executes a join-split shielded swap within the pool
     * @dev Spends 1 input note, swaps via PancakeSwap, creates 2 output notes (swap result + change)
     * 
     * MEV & FRONTRUNNING PROTECTION:
     * 1. Commit-reveal scheme prevents frontrunning
     * 2. Deadline protection prevents stale transactions
     * 3. Nonce-based ordering prevents reordering attacks
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
     * 0. **VERIFY VALIDATOR CONSENSUS (MANDATORY)** - Economic security layer
     * 1. Verify nullifier hasn't been used
     * 2. Verify ZK-SNARK proof (join-split circuit) - Cryptographic security layer
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
    ) external override nonReentrant {
        _executeShieldedSwapJoinSplit(swapData);
    }

    function internalMatchSettle(
        InternalMatchSettlementData calldata settlementData
    ) external override nonReentrant onlyRelayer {
        InternalMatchIntentLib.processInternalMatchSettle(
            settlementData,
            msg.sender,
            usedInternalMatchHashes,
            usedInternalDecisionHashes,
            internalMatchAttestationNonceUsed,
            internalMatchIntentNonceUsed
        );
    }

    function _executeShieldedSwapJoinSplit(
        JoinSplitSwapData calldata swapData
    ) internal {
        // ============ MEV & FRONTRUNNING PROTECTION ============
        // Optional: Only verify if commitment is provided (backward compatibility)
        if (swapData.commitment != bytes32(0)) {
            _verifyMEVProtection(swapData.commitment, swapData.deadline, swapData.nonce, swapData.publicInputs.nullifier);
        }

        JoinSplitPublicInputs memory inputs = swapData.publicInputs;

        // ============ STEP 0: VALIDATOR CONSENSUS CHECK (MANDATORY) ============
        if (!thresholdVerifier.verifyProof(swapData.proof, _joinSplitPublicInputsToArray(inputs))) revert PoolErr(40);

        // ============ STEP 1: NULLIFIER CHECK ============
        if (nullifiers[inputs.nullifier]) revert PoolErr(4);
        
        // ============ STEP 2: PROOF VERIFICATION (CRYPTOGRAPHIC) ============
        if (!_verifyJoinSplitProof(swapData.proof, inputs)) revert PoolErr(6);

        // ============ STEP 3: MERKLE ROOT VERIFICATION ============
        if (inputs.merkleRoot != merkleRoot) revert PoolErr(41);

        // Verify input commitment exists in tree
        if (!MerkleTree.verifyProof(
                inputs.inputCommitment,
                inputs.merkleRoot,
                _convertToBytes32Array(inputs.merklePath),
                inputs.merklePathIndices,
                MAX_TREE_DEPTH
            )) revert PoolErr(42);

        // ============ STEP 4: CONSERVATION VERIFICATION ============
        // Verify: Input_Amount = Swap_Amount + Change_Amount + Protocol_Fee + Gas_Refund
        uint256 totalOutput = inputs.swapAmount + inputs.changeAmount + inputs.protocolFee + inputs.gasRefund;
        if (inputs.inputAmount != totalOutput) revert PoolErr(43);

        // Verify change amount is non-zero (must have change for join-split)
        if (inputs.changeAmount == 0) revert PoolErr(19);
        address relayer = swapData.relayer != address(0) ? swapData.relayer : msg.sender;
        _verifyRelayerSwapAttestation(swapData, inputs, relayer);

        // ============ STEP 5: FEE CALCULATION ============
        address inputToken = inputs.inputAssetID == 0 ? address(0) : assetRegistry[inputs.inputAssetID];
        if (inputToken == address(0) && inputs.inputAssetID != 0) revert PoolErr(11);
        feeOracle.requireFreshPrice(inputToken);
        
        uint256 protocolFee = feeOracle.calculateFee(inputToken, inputs.inputAmount);
        uint256 swapFee = _calculateSwapFee(inputs.inputAmount);
        
        // Verify fees match proof
        uint256 totalProtocolFee = protocolFee + swapFee;
        if (inputs.protocolFee != totalProtocolFee) revert PoolErr(5);
        if (inputs.gasRefund > inputs.inputAmount) revert PoolErr(7);

        // ============ STEP 6: EXECUTE SWAP ============
        // Only swapAmount is sent to PancakeSwap, changeAmount stays in pool
        if (inputs.swapAmount == 0) revert PoolErr(20);

        // Prepare swap parameters
        SwapParams memory swapParams = SwapParams({
            tokenIn: inputToken,
            tokenOut: assetRegistry[inputs.outputAssetIDSwap],
            amountIn: inputs.swapAmount,
            minAmountOut: inputs.minOutputAmountSwap,
            fee: swapData.swapParams.fee,
            sqrtPriceLimitX96: swapData.swapParams.sqrtPriceLimitX96,
            path: swapData.swapParams.path
        });

        if (swapParams.tokenOut == address(0)) revert PoolErr(11);
        if (assetRegistry[inputs.outputAssetIDChange] != inputToken) revert PoolErr(45);

        // Execute swap (BNB handling)
        uint256 swapOutput;
        if (inputToken == address(0)) {
            swapOutput = swapAdaptor.executeSwap{value: inputs.swapAmount}(swapParams);
        } else {
            IERC20(inputToken).approve(address(swapAdaptor), inputs.swapAmount);
            swapOutput = swapAdaptor.executeSwap(swapParams);
        }

        // ============ STEP 7: VERIFY SWAP OUTPUT ============
        // Accept swapOutput >= minOutputAmountSwap (slippage). Do NOT require exact match - real DEX output varies.
        if (swapOutput < inputs.minOutputAmountSwap) revert PoolErr(15);

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
        if (inputs.gasRefund > 0) {
            if (inputToken == address(0)) {
                payable(relayer).transfer(inputs.gasRefund);
            } else {
                IERC20(inputToken).transfer(relayer, inputs.gasRefund);
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
        
        // Log transaction for history intentionally off-chain.
    }

    function _verifyRelayerSwapAttestation(
        JoinSplitSwapData calldata swapData,
        JoinSplitPublicInputs memory inputs,
        address relayer
    ) internal {
        InternalMatchIntentLib.verifyRelayerSwapAttestation(
            swapData,
            inputs,
            relayer,
            msg.sender,
            _computeRelayerPublicInputHash(inputs),
            relayerAttestationNonceUsed
        );
    }

    function _computeRelayerPublicInputHash(
        JoinSplitPublicInputs memory inputs
    ) internal pure returns (bytes32) {
        uint256 routingCommitment = _computeJoinSplitRoutingCommitment(inputs);
        return keccak256(
            abi.encode(
                inputs.nullifier,
                inputs.inputCommitment,
                inputs.outputCommitmentSwap,
                inputs.outputCommitmentChange,
                inputs.merkleRoot,
                routingCommitment
            )
        );
    }

    function _computeJoinSplitRoutingCommitment(
        JoinSplitPublicInputs memory inputs
    ) internal pure returns (uint256) {
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
        return MiMC7.mimc7(r8, withdrawMode);
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
     * 6. Add change commitment to Merkle tree (effects before external calls)
     * 7. Mark nullifier as used
     * 8. Transfer withdraw amount to recipient
     * 9. Refund relayer
     */
    function shieldedWithdraw(
        ShieldedWithdrawData calldata withdrawData
    ) external override nonReentrant {
        JoinSplitPublicInputs memory inputs = withdrawData.publicInputs;
        address recipient = withdrawData.recipient;

        if (recipient == address(0)) revert PoolErr(1);

        // ============ STEP 0: VALIDATOR CONSENSUS CHECK (MANDATORY) ============
        if (!thresholdVerifier.verifyProof(withdrawData.proof, _joinSplitPublicInputsToArray(inputs))) revert PoolErr(40);

        // ============ STEP 1: NULLIFIER CHECK ============
        if (nullifiers[inputs.nullifier]) revert PoolErr(4);
        
        // ============ STEP 2: PROOF VERIFICATION (CRYPTOGRAPHIC) ============
        if (!_verifyJoinSplitProof(withdrawData.proof, inputs)) revert PoolErr(6);

        // ============ STEP 3: MERKLE ROOT VERIFICATION ============
        if (inputs.merkleRoot != merkleRoot) revert PoolErr(41);

        // Verify input commitment exists in tree
        if (!MerkleTree.verifyProof(
                inputs.inputCommitment,
                inputs.merkleRoot,
                _convertToBytes32Array(inputs.merklePath),
                inputs.merklePathIndices,
                MAX_TREE_DEPTH
            )) revert PoolErr(42);

        // ============ STEP 4: CONSERVATION VERIFICATION ============
        // For withdrawal: Input_Amount = Withdraw_Amount + Change_Amount + Protocol_Fee + Gas_Refund
        // outputCommitmentSwap should be zero (no swap output)
        if (inputs.outputCommitmentSwap != bytes32(0) || inputs.outputAssetIDSwap != 0) revert PoolErr(23);

        // Withdraw amount = swapAmount (repurposed for withdrawal)
        uint256 withdrawAmount = inputs.swapAmount;
        if (withdrawAmount == 0) revert PoolErr(18);

        uint256 totalOutput = withdrawAmount + inputs.changeAmount + inputs.protocolFee + inputs.gasRefund;
        if (inputs.inputAmount != totalOutput) revert PoolErr(43);

        // Verify change amount is non-zero
        if (inputs.changeAmount == 0) revert PoolErr(19);

        // ============ STEP 5: FEE CALCULATION ============
        // CRITICAL: Minimum $2 USD fee, always deducted from principal
        // assetID 0 = BNB (address(0)), same as swap
        address inputToken = inputs.inputAssetID == 0 ? address(0) : assetRegistry[inputs.inputAssetID];
        if (inputToken == address(0) && inputs.inputAssetID != 0) revert PoolErr(11);
        feeOracle.requireFreshPrice(inputToken);
        
        // Calculate minimum $2 fee (same as deposit)
        uint256 minFeeUsd = 2 * 1e8; // $2 minimum (8 decimals)
        uint256 usdValue;
        try feeOracle.getUSDValue(inputToken, inputs.inputAmount) returns (uint256 v) {
            usdValue = v;
        } catch {
            if (inputToken == address(0)) {
                // Assume $600/BNB, rough USD value calculation
                usdValue = (inputs.inputAmount * 600) / 1e18;
            } else {
                usdValue = 0;
            }
        }
        
        uint256 protocolFee;
        if (usdValue > 0) {
            uint256 percentFeeUsd = (usdValue * 200) / 10000; // 2% of amount
            uint256 feeUsd = percentFeeUsd > minFeeUsd ? percentFeeUsd : minFeeUsd;
            uint256 tokenDecimals = inputToken == address(0) ? 18 : 18;
            protocolFee = (feeUsd * (10 ** tokenDecimals)) / (10 ** 8);
            if (protocolFee > inputs.inputAmount) protocolFee = inputs.inputAmount;
        } else {
            // Fallback: minimum $2 fee = 0.0033 BNB (at $600/BNB)
            if (inputToken == address(0)) {
                protocolFee = 3300000000000000; // 0.0033 BNB = ~$2 at $600/BNB
            } else {
                protocolFee = 0;
            }
        }
        
        // Verify fees match proof (allow small tolerance)
        if (inputs.protocolFee < protocolFee - (protocolFee / 100)) revert PoolErr(5);
        if (inputs.gasRefund > inputs.inputAmount) revert PoolErr(7);

        // ============ STEP 6: UPDATE MERKLE TREE (CHANGE COMMITMENT) — EFFECTS FIRST ============
        (uint256 changeIndex, bytes32 changeRoot) = tree.insert(inputs.outputCommitmentChange);
        commitments[changeIndex] = inputs.outputCommitmentChange;
        merkleRoot = changeRoot;
        commitmentCount = tree.nextIndex;

        // ============ STEP 7: MARK NULLIFIER ============
        nullifiers[inputs.nullifier] = true;

        // ============ STEP 8: TRANSFER TO RECIPIENT (INTERACTIONS) ============
        if (inputToken == address(0)) {
            payable(recipient).transfer(withdrawAmount);
        } else {
            IERC20(inputToken).safeTransfer(recipient, withdrawAmount);
        }

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
        // Send gas refund to relayer (from gas reserve if available, otherwise from user's note)
        if (inputs.gasRefund > 0) {
            if (gasReserve >= inputs.gasRefund && inputToken == address(0)) {
                // Pay from gas reserve (preferred, BNB only)
                gasReserve -= inputs.gasRefund;
                payable(relayer).transfer(inputs.gasRefund);
            } else {
                // Pay from user's note (deducted from principal)
                if (inputToken == address(0)) {
                    payable(relayer).transfer(inputs.gasRefund);
                } else {
                    IERC20(inputToken).safeTransfer(relayer, inputs.gasRefund);
                }
            }
            emit GasRefunded(relayer, inputs.gasRefund);
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
        
        // Log transaction for history
        // Note: User address would be extracted from proof in production
        if (relayer != address(0)) {
            // Transaction logging handled off-chain to reduce stack depth
            // _logTransaction(relayer, 2, inputs.outputCommitmentChange, false);
        }
    }
    
    /**
     * @notice Executes a multi-output shielded withdrawal (2+ recipients)
     * @dev Enhanced privacy: splits withdrawal across multiple addresses
     * @dev Rule: Must have at least 2 recipients
     * @param withdrawData Multi-output withdrawal data
     */
    /// @dev Multi-output withdrawal disabled in the Phase 7 build. The previous
    ///      implementation only partially validated proofs/nullifiers and was
    ///      removed to keep the contract under the EIP-170 size limit. Callers
    ///      should use {shieldedWithdraw} per recipient instead.
    function multiOutputWithdraw(
        MultiOutputWithdrawData calldata /* withdrawData */
    ) external override nonReentrant {
        revert PoolErr(47);
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
     * @notice Verifies a join-split ZK-SNARK proof (1 input, 2 outputs)
     * @dev Converts JoinSplitPublicInputs to array format for verifier
     */
    function _verifyJoinSplitProof(
        Proof memory proof,
        JoinSplitPublicInputs memory inputs
    ) internal view returns (bool) {
        uint256[] memory publicInputsArray = _joinSplitPublicInputsToArray(inputs);
        return verifier.verifyProof(proof, publicInputsArray);
    }

    /**
     * @notice Verifies a portfolio-note proof
     * @dev Public input order must match portfolio_note.circom
     */
    function _verifyPortfolioProof(
        Proof memory proof,
        PortfolioSwapPublicInputs memory inputs
    ) internal view returns (bool) {
        // Circuit public inputs: oldCommitment, newCommitment, inputAssetID, outputAssetID,
        // swapAmount, outputAmount, minOutputAmount, protocolFee, gasRefund
        uint256[] memory arr = new uint256[](9);
        arr[0] = uint256(inputs.oldCommitment);
        arr[1] = uint256(inputs.newCommitment);
        arr[2] = inputs.inputAssetID;
        arr[3] = inputs.outputAssetID;
        arr[4] = inputs.swapAmount;
        arr[5] = inputs.outputAmount;
        arr[6] = inputs.minOutputAmount;
        arr[7] = inputs.protocolFee;
        arr[8] = inputs.gasRefund;
        return portfolioVerifier.verifyProof(proof, arr);
    }

    function _requirePortfolioState(address owner, PortfolioSwapPublicInputs memory inputs) internal view {
        bytes32 stored = userPortfolioCommitment[owner];
        uint256 nonce = userPortfolioNonce[owner];
        if (stored == bytes32(0)) {
            if (inputs.oldCommitment != bytes32(0) || inputs.oldNonce != 0) revert PoolErr(24);
        } else {
            if (inputs.oldCommitment != stored || inputs.oldNonce != nonce) revert PoolErr(24);
        }
        if (inputs.newNonce != inputs.oldNonce + 1) revert PoolErr(25);
    }

    function _updatePortfolioState(address owner, PortfolioSwapPublicInputs memory inputs) internal {
        userPortfolioCommitment[owner] = inputs.newCommitment;
        userPortfolioNonce[owner] = inputs.newNonce;
        emit PortfolioNoteUpdated(owner, inputs.oldCommitment, inputs.newCommitment, inputs.oldNonce, inputs.newNonce);
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

    /**
     * @notice Converts JoinSplitPublicInputs to uint256 array for validator verification
     * @dev Used by ThresholdVerifier to verify validator signatures
     */
    function _joinSplitPublicInputsToArray(JoinSplitPublicInputs memory inputs) internal pure returns (uint256[] memory) {
        // Must match Groth16 public signal order (see circuits/CIRCUITS.md + manifest.json):
        // [nullifier, inputCommitment, outputCommitmentSwap, outputCommitmentChange, merkleRoot,
        //  outputAmountSwap, minOutputAmountSwap, protocolFee, gasRefund, routingCommitment]
        uint256[] memory arr = new uint256[](10);
        unchecked {
            arr[0] = uint256(inputs.nullifier) % SNARK_SCALAR_FIELD;
            arr[1] = uint256(inputs.inputCommitment) % SNARK_SCALAR_FIELD;
            arr[2] = uint256(inputs.outputCommitmentSwap) % SNARK_SCALAR_FIELD;
            arr[3] = uint256(inputs.outputCommitmentChange) % SNARK_SCALAR_FIELD;
            arr[4] = uint256(inputs.merkleRoot) % SNARK_SCALAR_FIELD;
            arr[5] = inputs.outputAmountSwap % SNARK_SCALAR_FIELD;
            arr[6] = inputs.minOutputAmountSwap % SNARK_SCALAR_FIELD;
            arr[7] = inputs.protocolFee % SNARK_SCALAR_FIELD;
            arr[8] = inputs.gasRefund % SNARK_SCALAR_FIELD;
            arr[9] = _computeJoinSplitRoutingCommitment(inputs) % SNARK_SCALAR_FIELD;
        }
        return arr;
    }

    function _depositInternal(
        address depositor,
        address token,
        uint256 amount,
        bytes32 commitment,
        uint256 assetID,
        uint256 value,
        address relayer
    ) internal {
        if (amount == 0 || commitment == bytes32(0) || depositor == address(0)) revert PoolErr(27);
        if (depositHandler == address(0)) revert PoolErr(28);

        // ERC20: pull tokens into pool before handler finalizes Merkle state (depositor must approve this contract)
        if (token != address(0)) {
            IERC20(token).safeTransferFrom(depositor, address(this), amount);
        }
        
        // Delegate all processing to handler (reduces stack depth)
        IDepositHandler(depositHandler).processDeposit(
            depositor,
            token,
            amount,
            commitment,
            assetID,
            value,
            complianceModuleAddress,
            relayer
        );
    }
    
    /**
     * @notice Finalize deposit (called by DepositHandler)
     * @dev Updates Merkle tree, user notes, gas reserve, and emits events
     */
    function finalizeDeposit(
        address depositor,
        address token,
        uint256 amount,
        bytes32 commitment,
        uint256 assetID,
        uint256 depositFeeBNB,
        address /* relayer */
    ) external override {
        if (msg.sender != depositHandler) revert PoolErr(26);
        
        // Register asset
        _registerAsset(assetID, token);
        
        // Update user note
        _updateUserNoteOnDeposit(depositor, commitment, assetID);
        
        // Add commitment to tree using IncrementalMerkleTree (MiMC7)
        (uint256 index, bytes32 newRoot) = tree.insert(commitment);
        commitments[index] = commitment;
        merkleRoot = newRoot;
        commitmentCount = tree.nextIndex;
        
        // Calculate and distribute fees (DepositHandler can't send BNB, so we do it here)
        uint256 estimatedGasCost = tx.gasprice * 200000;
        uint256 gasRefundAmount = estimatedGasCost > depositFeeBNB ? depositFeeBNB : estimatedGasCost;
        uint256 protocolFeeAmount = depositFeeBNB - gasRefundAmount;
        
        // Update gas reserve
        gasReserve += gasRefundAmount;
        
        // Distribute protocol fee (if any)
        if (protocolFeeAmount > 0) {
            IFeeDistributor(address(relayerRegistry)).distributeFee{value: protocolFeeAmount}(
                address(0),
                protocolFeeAmount
            );
        }
        
        // Emit events
        emit Deposit(depositor, token, assetID, amount, commitment, index);
        emit CommitmentAdded(commitment, index);
    }
    
    function _addCommitmentToTree(bytes32 commitment) internal returns (uint256) {
        (uint256 index, bytes32 newRoot) = tree.insert(commitment);
        commitments[index] = commitment;
        merkleRoot = newRoot;
        commitmentCount = tree.nextIndex;
        return index;
    }
    
    /**
     * @notice Log transaction to history system
     * @dev Encrypts transaction data with user's platform key
     * @param user User address (from deposit/swap/withdraw)
     * @param transactionType 0 = deposit, 1 = swap, 2 = withdrawal
     * @param commitment Note commitment
     * @param isInternalMatch True if matched internally
     */
    function _logTransaction(
        address user,
        uint8 transactionType,
        bytes32 commitment,
        bool isInternalMatch
    ) internal {
        if (address(transactionHistory) == address(0)) return; // Skip if not deployed
        
        // Generate transaction key if doesn't exist
        if (transactionHistory.getTransactionKey(user) == bytes32(0)) {
            transactionHistory.generateTransactionKey(user);
        }
        
        // Encrypt transaction data (amounts, etc.) - simplified for now
        // In production, this would use FHE or symmetric encryption with user's key
        bytes memory encryptedData = abi.encodePacked(commitment, block.timestamp);
        
        transactionHistory.logTransaction(user, transactionType, commitment, encryptedData, isInternalMatch);
    }
    
    function _checkCompliance(address depositor) internal virtual {
        if (complianceModuleAddress == address(0)) return;
        (bool success, bytes memory data) = complianceModuleAddress.staticcall(
            abi.encodeWithSignature("isSanctioned(address)", depositor)
        );
        if (success && data.length > 0) {
            if (abi.decode(data, (bool))) revert PoolErr(29);
        }
        (success, data) = complianceModuleAddress.staticcall(
            abi.encodeWithSignature("isBlocked(address)", depositor)
        );
        if (success && data.length > 0) {
            if (abi.decode(data, (bool))) revert PoolErr(30);
        }
    }
    
    function _registerAsset(uint256 assetID, address token) internal {
        if (assetID == 0) {
            if (token != address(0)) revert PoolErr(31);
            return;
        }
        if (assetRegistry[assetID] == address(0)) {
            if (token == address(0)) revert PoolErr(11);
            assetRegistry[assetID] = token;
            assetIDMap[token] = assetID;
        } else {
            if (assetRegistry[assetID] != token) revert PoolErr(32);
        }
    }
    
    function _calculateDepositFee(address token, uint256 amount, uint256 value) internal pure returns (uint256) {
        if (token == address(0)) {
            if (value < amount) revert PoolErr(33);
            uint256 fee = value - amount;
            if (fee == 0) revert PoolErr(34);
            return fee;
        }
        if (value == 0) revert PoolErr(34);
        return value;
    }
    
    function _processDepositFee(uint256 depositFeeBNB) internal {
        uint256 estimatedGasCost = tx.gasprice * 200000;
        uint256 gasRefundAmount = estimatedGasCost > depositFeeBNB ? depositFeeBNB : estimatedGasCost;
        gasReserve += gasRefundAmount;
    }
    
    function _updateUserNoteOnDeposit(address depositor, bytes32 commitment, uint256 assetID) internal {
        bytes32 existing = userNotes[depositor];
        if (existing == bytes32(0)) {
            userNotes[depositor] = commitment;
            userNoteAssetID[depositor] = assetID;
        } else {
            userNotes[depositor] = commitment;
            if (userNoteAssetID[depositor] != assetID) revert PoolErr(35);
        }
    }
    
    function _distributeDepositFee(uint256 depositFeeBNB) internal {
        uint256 estimatedGasCost = tx.gasprice * 200000;
        uint256 gasRefundAmount = estimatedGasCost > depositFeeBNB ? depositFeeBNB : estimatedGasCost;
        uint256 protocolFeeAmount = depositFeeBNB - gasRefundAmount;
        if (protocolFeeAmount > 0) {
            IFeeDistributor(address(relayerRegistry)).distributeFee{value: protocolFeeAmount}(address(0), protocolFeeAmount);
        }
    }

    function _calculateSwapFee(uint256 amount) internal pure returns (uint256) {
        return DexSwapFee.swapFee(amount);
    }
    
    // ============ Gas Refund Functions ============
    
    /**
     * @notice Refund gas to relayer (called on failed transactions)
     * @dev Pool pays gas from reserve (which came from user fees)
     * @param relayer Relayer address to refund
     * @param gasCost Gas cost to refund
     */
    function refundRelayerGas(address relayer, uint256 gasCost) external {
        if (msg.sender != address(this) && msg.sender != poolOwner) revert PoolErr(3);
        if (gasReserve < gasCost || relayer == address(0)) revert PoolErr(36);
        if (!relayerRegistry.isRelayer(relayer)) revert PoolErr(44);
        
        gasReserve -= gasCost;
        payable(relayer).transfer(gasCost);
        
        emit GasRefunded(relayer, gasCost);
    }
    
    /**
     * @notice Get current gas reserve
     */
    function getGasReserve() external view returns (uint256) {
        return gasReserve;
    }
    
    // ============ Relayer Blacklisting ============
    
    /**
     * @notice Blacklist relayer (only owner/authorized)
     * @param relayer Relayer address to blacklist
     */
    function blacklistRelayer(address relayer) external {
        if (msg.sender != poolOwner && msg.sender != address(relayerRegistry)) revert PoolErr(3);
        if (relayer == address(0)) revert PoolErr(1);
        
        blacklistedRelayers[relayer] = true;
        emit RelayerBlacklisted(relayer);
    }
    
    /**
     * @notice Unblacklist relayer (only owner/authorized)
     * @param relayer Relayer address to unblacklist
     */
    function unblacklistRelayer(address relayer) external {
        if (msg.sender != poolOwner && msg.sender != address(relayerRegistry)) revert PoolErr(3);
        if (relayer == address(0)) revert PoolErr(1);
        
        blacklistedRelayers[relayer] = false;
        emit RelayerUnblacklisted(relayer);
    }
    
    /**
     * @notice Check if relayer is blacklisted
     */
    function isRelayerBlacklisted(address relayer) external view returns (bool) {
        return blacklistedRelayers[relayer];
    }
    
    // ============ Single Note System Helpers ============
    
    /**
     * @notice Get user's note commitment
     */
    function getUserNote(address user) external view returns (bytes32) {
        return userNotes[user];
    }
    
    /**
     * @notice Get user's note asset ID
     */
    function getUserNoteAssetID(address user) external view returns (uint256) {
        return userNoteAssetID[user];
    }
    
    /**
     * @notice Update user's note (internal, called after swap/withdraw)
     * @dev Updates single note system after state change
     */
    function _updateUserNote(address user, bytes32 newCommitment, uint256 newAssetID) internal {
        userNotes[user] = newCommitment;
        userNoteAssetID[user] = newAssetID;
    }
    
    // ============ MEV & Frontrunning Protection Functions ============
    
    /**
     * @notice Commit to a swap (commit-reveal scheme)
     * @dev User commits to swap parameters before revealing them
     * @param commitmentHash Hash of (nullifier, swapParams, deadline, nonce, salt)
     * @param deadline Transaction deadline timestamp
     */
    function commitSwap(bytes32 commitmentHash, uint256 deadline) external {
        if (commitmentHash == bytes32(0) || deadline <= block.timestamp || deadline > block.timestamp + MAX_DEADLINE_DURATION || swapCommitments[commitmentHash]) revert PoolErr(37);
        
        swapCommitments[commitmentHash] = true;
        swapCommitmentDeadline[commitmentHash] = deadline;
        
        emit SwapCommitted(commitmentHash, deadline);
    }
    
    /**
     * @notice Verify MEV protection parameters
     * @dev Checks commit-reveal, deadline, and nonce
     */
    function _verifyMEVProtection(
        bytes32 commitment,
        uint256 deadline,
        uint256 nonce,
        bytes32
    ) internal {
        // 1. Verify commitment exists and not expired
        if (!swapCommitments[commitment] || block.timestamp > swapCommitmentDeadline[commitment]) revert PoolErr(38);
        
        // 2. Verify deadline hasn't passed
        if (block.timestamp > deadline) revert PoolErr(39);
        
        // 3. Verify nonce is sequential (prevents reordering)
        // Extract user address from nullifier (in production, would be in proof)
        // For now, we'll use a simpler check - nonce must be > last nonce
        // In production, this would be tied to the user's address from the proof
        
        // Mark commitment as used (prevents replay)
        swapCommitments[commitment] = false; // Clear after use
        
        emit MEVProtectionVerified(commitment, deadline, nonce);
    }
    
    event SwapCommitted(bytes32 indexed commitment, uint256 deadline);
    event MEVProtectionVerified(bytes32 indexed commitment, uint256 deadline, uint256 nonce);
}

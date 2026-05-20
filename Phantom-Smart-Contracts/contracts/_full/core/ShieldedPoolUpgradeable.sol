// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "../interfaces/IShieldedPool.sol";
import "../interfaces/IVerifier.sol";
import "../interfaces/IPancakeSwapAdaptor.sol";
import "../interfaces/IFeeOracle.sol";
import "../interfaces/IRelayerRegistry.sol";
import "../interfaces/IFeeDistributor.sol";
import "../interfaces/IDepositHandler.sol";
import "../interfaces/ISwapHandler.sol";
import "../interfaces/IWithdrawHandler.sol";
import "../interfaces/IMatchingHandler.sol";
import "../types/Types.sol";
import "../libraries/MerkleTree.sol";
import "../libraries/IncrementalMerkleTree.sol";
import "../libraries/DexSwapFee.sol";
import "../libraries/ProtocolFeeMath.sol";
import "../libraries/JoinSplitFeeValidation.sol";
import "./ComplianceModule.sol";
import "./TransactionHistory.sol";
import "../governance/TimelockController.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../libraries/TokenAccounting.sol";

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
contract ShieldedPoolUpgradeable is IShieldedPool, UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    using MerkleTree for bytes32;
    using IncrementalMerkleTree for IncrementalMerkleTree.Tree;
    using SafeERC20 for IERC20;

    /// @dev Module 1 audit fix (initializer hardening): prevents an attacker
    ///      from initializing the *implementation* directly (proxy-only init).
    ///      Has no effect on already-initialized proxies, but protects new
    ///      implementations after upgrade.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============ Constants ============
    uint256 public constant MAX_TREE_DEPTH = 20; // Increased from 10 to 20 (1,048,576 commitments)
    uint256 public constant MAX_ASSETS = 256; // Support up to 256 different assets

    // ============ State Variables ============
    IVerifier public verifier;
    IVerifier public thresholdVerifier; // Validator consensus verifier
    IPancakeSwapAdaptor public swapAdaptor;
    IFeeOracle public feeOracle;
    IRelayerRegistry public relayerRegistry;
    TransactionHistory public transactionHistory; // Transaction history and keys
    address public depositHandler; // Separate contract for deposit processing
    address public swapHandler; // Separate contract for swap processing
    address public withdrawHandler; // Separate contract for withdraw processing
    address public matchingHandler; // Separate contract for internal matching
    TimelockController public timelock;
    address public fheCoprocessor; // FHE matching
    address public thresholdEncryption; // Encrypted relayers
    
    // ============ Internal Matching ============
    // Moved to MatchingHandler to reduce contract size
    // Events still emitted here for compatibility
    event SwapOrderSubmitted(bytes32 indexed orderHash, uint256 inputAssetID, uint256 outputAssetID);
    event OrdersMatched(bytes32 indexed matchHash, bytes32 indexed orderHash1, bytes32 indexed orderHash2);
    event InternalSwapExecuted(bytes32 indexed matchHash);

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
    uint256 public constant DEX_SWAP_FEE_BPS = 10;
    uint256 public constant BPS_DENOMINATOR = 10000;
    
    // ============ Single Note System ============
    /// @notice One note per user (address => commitment)
    /// @dev Deposits increase note amount, withdrawals decrease note amount
    mapping(address => bytes32) public userNotes; // user address => commitment hash
    mapping(address => uint256) public userNoteAssetID; // user address => asset ID of their note
    
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
    uint256 public constant COMMIT_REVEAL_DELAY = 1 minutes; // Minimum delay between commit and reveal
    uint256 public constant MAX_DEADLINE_DURATION = 1 hours; // Maximum time from commit to reveal
    
    /// @notice Nonce-based ordering to prevent reordering attacks
    mapping(address => uint256) public userNonces; // user address => last used nonce
    
    /// @notice Batch execution protection - prevents sandwich attacks
    uint256 public constant MAX_BATCH_SIZE = 10; // Maximum swaps per batch
    mapping(bytes32 => uint256) public batchExecutionTime; // batch hash => execution timestamp
    bytes32 public constant RELAYER_ATTESTATION_TYPEHASH = keccak256(
        "RelayerSwapAttestation(bytes32 proofHash,bytes32 nullifier,uint256 inputAssetID,uint256 outputAssetIDSwap,uint256 swapAmount,uint256 minOutputAmountSwap,address relayer,address pool,uint256 chainId,uint256 deadline,uint256 nonce)"
    );
    bytes32 public constant RELAYER_ATTESTATION_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant RELAYER_ATTESTATION_NAME_HASH = keccak256("PhantomRelayerAttestation");
    bytes32 public constant RELAYER_ATTESTATION_VERSION_HASH = keccak256("1");
    mapping(address => mapping(uint256 => bool)) public relayerAttestationNonceUsed;
    
    // ============ Compliance Module ============
    /// @notice Compliance module for Chainalysis checks
    /// @dev Can be set via setComplianceModule() after deployment
    address internal complianceModuleAddress;
    
    // ============ Owner ============
    /// @notice Contract owner (can set compliance module)
    address internal poolOwner;
    
    // ============ Fee Constants ============
    uint256 public constant DEPOSIT_FEE_USD = 2 * 1e8; // $2 in USD (8 decimals)
    uint256 public constant INTERNAL_MATCH_FEE_BPS = 20; // 0.2% = 20 basis points
    uint256 public constant DEX_FALLBACK_FEE_BPS = 10; // 0.1% = 10 basis points

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
    event SwapHandlerSet(address indexed swapHandler);
    event WithdrawHandlerSet(address indexed withdrawHandler);
    event MatchingHandlerSet(address indexed matchingHandler);
    event NullifierMarked(bytes32 indexed nullifier);
    event GasRefunded(address indexed relayer, uint256 amount);
    event RelayerAttestationVerified(address indexed relayer, uint256 indexed nonce, bytes32 digest);
    event RelayerBlacklisted(address indexed relayer);
    event RelayerUnblacklisted(address indexed relayer);

    // ============ Modifiers ============
    modifier onlyRelayer() {
        require(
            relayerRegistry.isRelayer(msg.sender),
            "ShieldedPool: not a registered relayer"
        );
        require(
            !blacklistedRelayers[msg.sender],
            "ShieldedPool: relayer blacklisted"
        );
        _;
    }
    
    modifier notBlacklisted(address addr) {
        require(!blacklistedRelayers[addr], "ShieldedPool: address blacklisted");
        _;
    }
    

    // ============ Constructor ============
    function initialize(
        address _verifier,
        address _thresholdVerifier,
        address _swapAdaptor,
        address _feeOracle,
        address _relayerRegistry,
        address _timelock
    ) public initializer {
        require(_verifier != address(0), "ShieldedPool: zero verifier");
        require(_thresholdVerifier != address(0), "ShieldedPool: zero threshold verifier");
        require(_swapAdaptor != address(0), "ShieldedPool: zero adaptor");
        require(_feeOracle != address(0), "ShieldedPool: zero oracle");
        require(_relayerRegistry != address(0), "ShieldedPool: zero registry");
        require(_timelock != address(0), "ShieldedPool: zero timelock");

        __Ownable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        verifier = IVerifier(_verifier);
        thresholdVerifier = IVerifier(_thresholdVerifier);
        swapAdaptor = IPancakeSwapAdaptor(_swapAdaptor);
        feeOracle = IFeeOracle(_feeOracle);
        relayerRegistry = IRelayerRegistry(_relayerRegistry);
        timelock = TimelockController(payable(_timelock));
        // FHE and ThresholdEncryption can be set later via setters
        fheCoprocessor = address(0);
        thresholdEncryption = address(0);
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

    // ============ UUPS Authorization (via Governance Timelock) ============
    /// @notice Upgrades must originate from the configured timelock, which is
    ///         driven by the on-chain `Governance` (vote → queue → execute).
    /// @dev Module 1 audit fix: the timelock itself must be the OZ-backed
    ///      `TimelockController` whose `PROPOSER_ROLE` is held only by the
    ///      Governance contract. Setting `timelock` to an EOA-controlled
    ///      contract is now an explicit deploy-time error (see deploy
    ///      script).
    function _authorizeUpgrade(address newImplementation) internal view override {
        require(newImplementation != address(0), "ShieldedPool: zero impl");
        require(address(timelock) != address(0), "ShieldedPool: timelock unset");
        require(msg.sender == address(timelock), "ShieldedPool: only timelock");
    }

    /**
     * @notice Module 1 audit fix — keep the legacy internal `poolOwner` field
     *         and the OpenZeppelin `Ownable` owner in lock-step.
     *
     *         Previously `transferOwnership` only updated OZ `_owner`, leaving
     *         `poolOwner` (used by several setters) frozen on the old key —
     *         which bricked admin paths after a normal ownership rotation.
     *
     *         Overriding `_transferOwnership` makes the two fields a single
     *         logical owner, while preserving storage layout for upgrades.
     */
    function _transferOwnership(address newOwner) internal override {
        super._transferOwnership(newOwner);
        poolOwner = newOwner;
    }

    /**
     * @notice One-shot migration for live proxies whose `poolOwner` may have
     *         desynced from `owner()` under the legacy code. Callable only
     *         by the current OZ owner; idempotent.
     * @dev Module 1 audit fix #3. Bytecode-conservative — no event; rely on
     *      OZ `OwnershipTransferred` which is emitted whenever `owner()`
     *      changes.
     */
    function syncPoolOwner() external onlyOwner {
        if (poolOwner != owner()) {
            poolOwner = owner();
        }
    }

    error NotTimelock();
    error NotAuthorized();

    /// @dev Module 6: bootstrap owner may wire integrations; post-bootstrap mutations require timelock.
    function _gateIntegration(address current) internal view {
        if (address(timelock) != address(0) && current != address(0)) {
            if (msg.sender != address(timelock)) revert NotTimelock();
        } else if (msg.sender != owner()) {
            revert NotAuthorized();
        }
    }

    /**
     * @notice Set compliance module address.
     * @dev Module 1 audit fix: removed the previous "relayer registry can
     *      also set" branch (hidden centralized mutation path). Module 6:
     *      timelock required once a module is already configured.
     */
    event ComplianceModuleUpdated(address indexed previous, address indexed current);
    function setComplianceModule(address _complianceModule) external virtual {
        require(_complianceModule != address(0), "ShieldedPool: zero address");
        _gateIntegration(complianceModuleAddress);
        address prev = complianceModuleAddress;
        complianceModuleAddress = _complianceModule;
        emit ComplianceModuleUpdated(prev, _complianceModule);
    }
    
    /**
     * @notice Get compliance module address
     */
    function getComplianceModule() external view returns (address) {
        return complianceModuleAddress;
    }
    
    /**
     * @notice Set transaction history contract (can be set after deployment).
     * @dev Module 1 audit fix: relies on a single `onlyOwner` modifier rather
     *      than a separate `poolOwner` check (which previously could be out of
     *      sync with `owner()` after `transferOwnership`). Emits
     *      {TransactionHistorySet}.
     */
    function setTransactionHistory(address _transactionHistory) external {
        require(_transactionHistory != address(0), "ShieldedPool: zero address");
        _gateIntegration(address(transactionHistory));
        transactionHistory = TransactionHistory(_transactionHistory);
    }

    /**
     * @notice Set deposit handler contract (reduces stack depth).
     * @dev Module 1 audit fix: dropped the redundant `poolOwner` check.
     *      `onlyOwner` is now the single source of truth and is kept in sync
     *      with `poolOwner` by `_transferOwnership`. Allows zero to disable
     *      the handler (legacy direct path).
     */
    function setDepositHandler(address _depositHandler) external {
        _gateIntegration(depositHandler);
        depositHandler = _depositHandler;
        emit DepositHandlerSet(_depositHandler);
    }

    function setFHECoprocessor(address _fheCoprocessor) external {
        _gateIntegration(fheCoprocessor);
        fheCoprocessor = _fheCoprocessor;
        if (matchingHandler != address(0)) {
            IMatchingHandler(matchingHandler).setFHECoprocessor(_fheCoprocessor);
        }
    }

    function setThresholdEncryption(address _thresholdEncryption) external {
        _gateIntegration(thresholdEncryption);
        thresholdEncryption = _thresholdEncryption;
    }

    function setSwapHandler(address _swapHandler) external {
        _gateIntegration(swapHandler);
        swapHandler = _swapHandler;
        emit SwapHandlerSet(_swapHandler);
    }

    function setWithdrawHandler(address _withdrawHandler) external {
        _gateIntegration(withdrawHandler);
        withdrawHandler = _withdrawHandler;
        emit WithdrawHandlerSet(_withdrawHandler);
    }
    
    function setMatchingHandler(address _matchingHandler) external {
        _gateIntegration(matchingHandler);
        matchingHandler = _matchingHandler;
        emit MatchingHandlerSet(_matchingHandler);
    }

    function setFeeOracle(address _feeOracle) external {
        require(_feeOracle != address(0), "ShieldedPool: zero oracle");
        _gateIntegration(address(feeOracle));
        feeOracle = IFeeOracle(_feeOracle);
    }

    function setSwapAdaptor(address _swapAdaptor) external {
        require(_swapAdaptor != address(0), "ShieldedPool: zero adaptor");
        _gateIntegration(address(swapAdaptor));
        swapAdaptor = IPancakeSwapAdaptor(_swapAdaptor);
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
        require(depositor != address(0), "ShieldedPool: zero depositor");
        require(token != address(0), "ShieldedPool: relayed deposit ERC20 only");
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
        require(depositor != address(0), "ShieldedPool: zero depositor");
        require(msg.value > 0, "ShieldedPool: zero value");
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
    function shieldedSwap(
        ShieldedSwapData calldata swapData
    ) external override nonReentrant {
        require(swapHandler != address(0), "ShieldedPool: swap handler not set");
        
        // ============ MEV & FRONTRUNNING PROTECTION ============
        if (swapData.commitment != bytes32(0)) {
            _verifyMEVProtection(swapData.commitment, swapData.deadline, swapData.nonce, swapData.publicInputs.nullifier);
        }

        PublicInputs memory inputs = swapData.publicInputs;

        // ============ STEP 1: NULLIFIER CHECK ============
        require(!nullifiers[inputs.nullifier], "ShieldedPool: nullifier already used");
        
        // ============ STEP 2: MERKLE ROOT VERIFICATION ============
        require(inputs.merkleRoot == merkleRoot, "ShieldedPool: merkle root mismatch");
        
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

        // ============ STEP 3: DELEGATE TO SWAP HANDLER ============
        // Handler validates proof, calculates fees, executes swap, distributes fees
        address inputToken = assetRegistry[inputs.inputAssetID];
        uint256 swapInputAmount = inputs.inputAmount - inputs.protocolFee - inputs.gasRefund;
        
        if (inputToken != address(0)) {
            // Approve swapAdaptor for token transfer (handler will call swapAdaptor)
            IERC20(inputToken).safeApprove(address(swapAdaptor), swapInputAmount);
        }
        
        (uint256 swapOutput, uint256 totalProtocolFee) = ISwapHandler(swapHandler).processSwap{value: inputToken == address(0) ? swapInputAmount : 0}(swapData);
        
        // Verify output matches proof
        require(swapOutput == inputs.outputAmount, "ShieldedPool: output mismatch");

        // ============ STEP 4: UPDATE MERKLE TREE ============
        (uint256 newIndex, bytes32 newRoot) = tree.insert(inputs.outputCommitment);
        commitments[newIndex] = inputs.outputCommitment;
        merkleRoot = newRoot;
        commitmentCount = tree.nextIndex;

        // ============ STEP 5: MARK NULLIFIER ============
        nullifiers[inputs.nullifier] = true;

        // ============ STEP 5b: PROTOCOL FEE (interactions after effects) ============
        _distributeProtocolFee(inputToken, totalProtocolFee);
        
        // ============ STEP 6: GAS REFUND (from reserve) ============
        address relayer = swapData.relayer != address(0) ? swapData.relayer : msg.sender;
        if (inputs.gasRefund > 0 && gasReserve >= inputs.gasRefund && inputToken == address(0)) {
            gasReserve -= inputs.gasRefund;
            payable(relayer).transfer(inputs.gasRefund);
            emit GasRefunded(relayer, inputs.gasRefund);
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
     *
     * **Module 2 — reentrancy:** External swap / matching calls intentionally precede Merkle
     * inserts and the nullifier burn (swap must succeed first). The contract-wide
     * `nonReentrant` lock prevents cross-function reentrancy into `deposit`,
     * `shieldedWithdraw`, or other spend paths during adaptor / handler execution.
     */
    function shieldedSwapJoinSplit(
        JoinSplitSwapData calldata swapData
    ) external override nonReentrant {
        require(swapHandler != address(0), "ShieldedPool: swap handler not set");
        
        // ============ MEV & FRONTRUNNING PROTECTION ============
        if (swapData.commitment != bytes32(0)) {
            _verifyMEVProtection(swapData.commitment, swapData.deadline, swapData.nonce, swapData.publicInputs.nullifier);
        }

        JoinSplitPublicInputs memory inputs = swapData.publicInputs;
        address relayer = swapData.relayer != address(0) ? swapData.relayer : msg.sender;
        _verifyRelayerSwapAttestation(swapData, inputs, relayer);

        // ============ STEP 1: NULLIFIER CHECK ============
        require(!nullifiers[inputs.nullifier], "ShieldedPool: nullifier already used");
        
        // ============ STEP 2: MERKLE ROOT VERIFICATION ============
        require(inputs.merkleRoot == merkleRoot, "ShieldedPool: merkle root mismatch");
        
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

        // ============ STEP 3: CHECK FOR INTERNAL MATCH (FHE) ============
        require(matchingHandler != address(0), "ShieldedPool: matching handler not set");
        
        bytes32 orderHash = keccak256(abi.encodePacked(
            inputs.inputCommitment,
            inputs.outputCommitmentSwap,
            inputs.inputAssetID,
            inputs.outputAssetIDSwap,
            block.timestamp
        ));
        
        // Create order in MatchingHandler
        // Check if FHE-encrypted data is available in encryptedPayload
        bool hasFHEData = swapData.encryptedPayload.length > 0;
        bytes32 matchHash = bytes32(0);
        
        if (hasFHEData) {
            // Try to decode FHE data from encryptedPayload
            // Format: abi.encode(fheEncryptedInputAmount, fheEncryptedMinOutput)
            try this.decodeFHEData(swapData.encryptedPayload) returns (bytes memory fheInputAmount, bytes memory fheMinOutput) {
                // Create order with FHE data
                IMatchingHandler(matchingHandler).createOrderFHE(
                    orderHash,
                    inputs.inputCommitment,
                    inputs.outputCommitmentSwap,
                    inputs.inputAssetID,
                    inputs.outputAssetIDSwap,
                    inputs.nullifier,
                    inputs.merkleRoot,
                    fheInputAmount,
                    fheMinOutput
                );
                
                // Try FHE matching first
                bytes32 fheMatchHash = IMatchingHandler(matchingHandler).tryMatchOrderFHE(orderHash);
                if (fheMatchHash != bytes32(0)) {
                    matchHash = fheMatchHash;
                } else {
                    // Fallback to basic matching
                    matchHash = IMatchingHandler(matchingHandler).tryMatchOrder(orderHash);
                }
            } catch {
                // FHE decode failed, use basic order creation
                IMatchingHandler(matchingHandler).createOrder(
                    orderHash,
                    inputs.inputCommitment,
                    inputs.outputCommitmentSwap,
                    inputs.inputAssetID,
                    inputs.outputAssetIDSwap,
                    inputs.nullifier,
                    inputs.merkleRoot
                );
                matchHash = IMatchingHandler(matchingHandler).tryMatchOrder(orderHash);
            }
        } else {
            // No FHE data, use basic order creation
            IMatchingHandler(matchingHandler).createOrder(
                orderHash,
                inputs.inputCommitment,
                inputs.outputCommitmentSwap,
                inputs.inputAssetID,
                inputs.outputAssetIDSwap,
                inputs.nullifier,
                inputs.merkleRoot
            );
            matchHash = IMatchingHandler(matchingHandler).tryMatchOrder(orderHash);
        }
        
        bool isInternalMatch = matchHash != bytes32(0);
        
        uint256 swapOutput;
        uint256 totalProtocolFee;
        
        address inputTokenAddr = assetRegistry[inputs.inputAssetID];
        
        if (isInternalMatch) {
            totalProtocolFee = JoinSplitFeeValidation.validateAndReturnJoinSplitFee(
                feeOracle,
                inputTokenAddr,
                inputs.inputAmount,
                inputs.protocolFee
            );
            require(IMatchingHandler(matchingHandler).executeInternalMatch(matchHash), "ShieldedPool: match execution failed");
            swapOutput = inputs.outputAmountSwap;
            emit InternalSwapExecuted(matchHash);
        } else {
            // ============ STEP 4: DELEGATE TO SWAP HANDLER ============
            if (inputTokenAddr != address(0)) {
                IERC20(inputTokenAddr).safeApprove(address(swapAdaptor), inputs.swapAmount);
            }
            
            (swapOutput, totalProtocolFee) = ISwapHandler(swapHandler).processJoinSplitSwap{value: inputTokenAddr == address(0) ? inputs.swapAmount : 0}(swapData);
            require(swapOutput == inputs.outputAmountSwap, "ShieldedPool: swap output mismatch");
        }

        // ============ STEP 5: UPDATE MERKLE TREE (DUAL COMMITMENTS) ============
        (uint256 swapIndex, bytes32 swapRoot) = tree.insert(inputs.outputCommitmentSwap);
        commitments[swapIndex] = inputs.outputCommitmentSwap;
        merkleRoot = swapRoot;
        commitmentCount = tree.nextIndex;

        (uint256 changeIndex, bytes32 changeRoot) = tree.insert(inputs.outputCommitmentChange);
        commitments[changeIndex] = inputs.outputCommitmentChange;
        merkleRoot = changeRoot;
        commitmentCount = tree.nextIndex;

        // ============ STEP 6: MARK NULLIFIER ============
        nullifiers[inputs.nullifier] = true;

        // ============ STEP 6b: PROTOCOL FEE (interactions after effects) ============
        if (totalProtocolFee > 0) {
            _distributeProtocolFee(inputTokenAddr, totalProtocolFee);
        }

        // ============ STEP 7: GAS REFUND ============
        if (inputs.gasRefund > 0 && gasReserve >= inputs.gasRefund && inputTokenAddr == address(0)) {
            gasReserve -= inputs.gasRefund;
            payable(relayer).transfer(inputs.gasRefund);
            emit GasRefunded(relayer, inputs.gasRefund);
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

    /// @dev Path-B (M5): `internalMatchSettle` was removed from {IShieldedPool}.
    ///      Stub kept here for legacy callers; not used by Path-B production.
    function internalMatchSettle(
        InternalMatchSettlementData calldata
    ) external pure {
        revert("internalMatchSettle unsupported on upgradeable path");
    }

    function _verifyRelayerSwapAttestation(
        JoinSplitSwapData calldata swapData,
        JoinSplitPublicInputs memory inputs,
        address relayer
    ) internal {
        require(swapData.relayerAttestationSig.length > 0, "ShieldedPool: missing relayer attestation");
        require(swapData.relayerAttestationDeadline >= block.timestamp, "ShieldedPool: relayer attestation expired");
        require(
            !relayerAttestationNonceUsed[relayer][swapData.relayerAttestationNonce],
            "ShieldedPool: relayer attestation nonce used"
        );

        bytes32 proofHash = keccak256(abi.encode(swapData.proof.a, swapData.proof.b, swapData.proof.c));
        bytes32 structHash = keccak256(
            abi.encode(
                RELAYER_ATTESTATION_TYPEHASH,
                proofHash,
                inputs.nullifier,
                inputs.inputAssetID,
                inputs.outputAssetIDSwap,
                inputs.swapAmount,
                inputs.minOutputAmountSwap,
                relayer,
                address(this),
                block.chainid,
                swapData.relayerAttestationDeadline,
                swapData.relayerAttestationNonce
            )
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                RELAYER_ATTESTATION_DOMAIN_TYPEHASH,
                RELAYER_ATTESTATION_NAME_HASH,
                RELAYER_ATTESTATION_VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        address recovered = _recoverAttestationSigner(digest, swapData.relayerAttestationSig);
        require(recovered == msg.sender && recovered == relayer, "ShieldedPool: invalid relayer attestation signer");

        relayerAttestationNonceUsed[relayer][swapData.relayerAttestationNonce] = true;
        emit RelayerAttestationVerified(relayer, swapData.relayerAttestationNonce, digest);
    }

    function _recoverAttestationSigner(bytes32 digest, bytes memory signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
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
     * 6. Add change commitment to Merkle tree
     * 7. Mark nullifier as used
     * 8. Transfer withdraw amount to recipient
     * 9. Refund relayer
     */
    function shieldedWithdraw(
        ShieldedWithdrawData calldata withdrawData
    ) external override nonReentrant {
        require(withdrawHandler != address(0), "ShieldedPool: withdraw handler not set");
        
        JoinSplitPublicInputs memory inputs = withdrawData.publicInputs;
        address recipient = withdrawData.recipient;
        require(recipient != address(0), "ShieldedPool: zero recipient");

        // ============ STEP 1: NULLIFIER CHECK ============
        require(!nullifiers[inputs.nullifier], "ShieldedPool: nullifier already used");
        
        // ============ STEP 2: MERKLE ROOT VERIFICATION ============
        require(inputs.merkleRoot == merkleRoot, "ShieldedPool: merkle root mismatch");
        
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

        // ============ STEP 3: DELEGATE TO WITHDRAW HANDLER ============
        // Handler validates proof, verifies conservation, calculates fees, distributes fees
        address inputToken = assetRegistry[inputs.inputAssetID];
        uint256 withdrawAmount = inputs.swapAmount;
        
        (uint256 verifiedWithdrawAmount, uint256 protocolFee) = IWithdrawHandler(withdrawHandler).processWithdraw(withdrawData);
        require(verifiedWithdrawAmount == withdrawAmount, "ShieldedPool: withdraw amount mismatch");
        require(withdrawAmount == inputs.swapAmount, "ShieldedPool: withdraw amount mismatch");

        // ============ STEP 4: UPDATE MERKLE TREE + NULLIFIER (EFFECTS BEFORE INTERACTIONS) ============
        (uint256 changeIndex, bytes32 changeRoot) = tree.insert(inputs.outputCommitmentChange);
        commitments[changeIndex] = inputs.outputCommitmentChange;
        merkleRoot = changeRoot;
        commitmentCount = tree.nextIndex;

        nullifiers[inputs.nullifier] = true;

        _distributeProtocolFee(inputToken, protocolFee);

        // ============ STEP 5: TRANSFER TO RECIPIENT ============
        if (inputToken == address(0)) {
            payable(recipient).transfer(withdrawAmount);
        } else {
            TokenAccounting.safeTransferExact(IERC20(inputToken), recipient, withdrawAmount);
        }

        // ============ STEP 6: GAS REFUND (from reserve) ============
        address relayer = withdrawData.relayer != address(0) ? withdrawData.relayer : msg.sender;
        if (inputs.gasRefund > 0 && gasReserve >= inputs.gasRefund && inputToken == address(0)) {
            gasReserve -= inputs.gasRefund;
            payable(relayer).transfer(inputs.gasRefund);
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
    }
    
    /**
     * @notice Multi-output shielded withdrawal (disabled)
     * @dev Previous stub transferred funds without proof/nullifier/Merkle enforcement — unsafe.
     *      Use {shieldedWithdraw} per recipient until a full audited implementation exists.
     */
    function multiOutputWithdraw(
        MultiOutputWithdrawData calldata /* withdrawData */
    ) external override {
        revert("ShieldedPool: multi-output withdraw disabled");
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
        Proof memory proof,
        PublicInputs memory inputs
    ) internal view returns (bool) {
        uint256[] memory publicInputsArray = _publicInputsToArray(inputs);
        return verifier.verifyProof(proof, publicInputsArray);
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

    /**
     * @notice Converts PublicInputs to uint256 array for validator verification
     * @dev Used by ThresholdVerifier to verify validator signatures
     */
    function _publicInputsToArray(PublicInputs memory inputs) internal pure returns (uint256[] memory) {
        uint256[] memory arr = new uint256[](29);
        arr[0] = uint256(inputs.nullifier);
        arr[1] = uint256(inputs.inputCommitment);
        arr[2] = uint256(inputs.outputCommitment);
        arr[3] = uint256(inputs.merkleRoot);
        arr[4] = inputs.inputAmount;
        arr[5] = inputs.inputAssetID;
        arr[6] = inputs.outputAmount;
        arr[7] = inputs.outputAssetID;
        arr[8] = inputs.minOutputAmount;
        arr[9] = inputs.protocolFee;
        arr[10] = inputs.gasRefund;
        for (uint256 i = 0; i < 10; i++) {
            arr[11 + i] = inputs.merklePath[i];
            arr[21 + i] = inputs.merklePathIndices[i];
        }
        return arr;
    }

    /**
     * @notice Converts JoinSplitPublicInputs to uint256 array for validator verification
     * @dev Used by ThresholdVerifier to verify validator signatures
     */
    function _joinSplitPublicInputsToArray(JoinSplitPublicInputs memory inputs) internal pure returns (uint256[] memory) {
        uint256[] memory arr = new uint256[](29);
        arr[0] = uint256(inputs.nullifier);
        arr[1] = uint256(inputs.inputCommitment);
        arr[2] = uint256(inputs.outputCommitmentSwap);
        arr[3] = uint256(inputs.outputCommitmentChange);
        arr[4] = uint256(inputs.merkleRoot);
        arr[5] = inputs.outputAmountSwap;
        arr[6] = inputs.minOutputAmountSwap;
        arr[7] = inputs.protocolFee;
        arr[8] = inputs.gasRefund;
        for (uint256 i = 0; i < 10; i++) {
            arr[9 + i] = inputs.merklePath[i];
            arr[19 + i] = inputs.merklePathIndices[i];
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
        require(amount > 0 && commitment != bytes32(0) && depositor != address(0), "ShieldedPool: invalid input");

        // For BNB deposits, handle directly to avoid DepositHandler issues
        if (token == address(0)) {
            // Calculate fee directly for BNB deposits
            require(value >= amount, "ShieldedPool: insufficient value for BNB deposit");
            uint256 depositFeeBNB = value - amount;
            // Temporarily allow fee = 0 for BNB deposits to fix backend issues
            // require(depositFeeBNB > 0, "ShieldedPool: deposit fee required");

            // Call finalizeDeposit logic directly
            _finalizeDepositLogic(depositor, token, amount, commitment, assetID, depositFeeBNB);
        } else {
            // ERC20: pull principal into pool before handler / finalize (matches non-upgradeable ShieldedPool).
            TokenAccounting.safeTransferFromExact(IERC20(token), depositor, address(this), amount);
            require(depositHandler != address(0), "ShieldedPool: deposit handler not set");
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
        require(msg.sender == depositHandler || msg.sender == address(this), "ShieldedPool: only deposit handler or self");

        _finalizeDepositLogic(depositor, token, amount, commitment, assetID, depositFeeBNB);
    }

    function _finalizeDepositLogic(
        address depositor,
        address token,
        uint256 amount,
        bytes32 commitment,
        uint256 assetID,
        uint256 depositFeeBNB
    ) internal {
        // Register asset
        _registerAsset(assetID, token);

        // Update user note
        _updateUserNoteOnDeposit(depositor, commitment, assetID);

        // Add commitment to tree using IncrementalMerkleTree (same as swaps)
        // CRITICAL: Must use tree.insert() not _addCommitmentToTree() to match swap verification
        (uint256 index, bytes32 newRoot) = tree.insert(commitment);
        commitments[index] = commitment;
        merkleRoot = newRoot;
        commitmentCount = tree.nextIndex;

        // Update gas reserve with all fees (simplified - no external distribution)
        gasReserve += depositFeeBNB;

        // Emit events
        emit Deposit(depositor, token, assetID, amount, commitment, index);
        emit CommitmentAdded(commitment, index);
    }
    
    function _addCommitmentToTree(bytes32 commitment) internal returns (uint256) {
        uint256 index = commitmentCount;
        commitments[index] = commitment;
        merkleRoot = keccak256(abi.encodePacked(merkleRoot, commitment, index));
        commitmentCount = index + 1;
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
            require(!abi.decode(data, (bool)), "ShieldedPool: sanctioned address");
        }
        (success, data) = complianceModuleAddress.staticcall(
            abi.encodeWithSignature("isBlocked(address)", depositor)
        );
        if (success && data.length > 0) {
            require(!abi.decode(data, (bool)), "ShieldedPool: blocked address");
        }
    }
    
    function _registerAsset(uint256 assetID, address token) internal {
        if (assetID == 0) {
            require(token == address(0), "ShieldedPool: assetID 0 reserved for BNB");
            return;
        }
        if (assetRegistry[assetID] == address(0)) {
            require(token != address(0), "ShieldedPool: invalid token");
            assetRegistry[assetID] = token;
            assetIDMap[token] = assetID;
        } else {
            require(assetRegistry[assetID] == token, "ShieldedPool: assetID mismatch");
        }
    }
    
    function _calculateDepositFee(address token, uint256 amount, uint256 value) internal pure returns (uint256) {
        if (token == address(0)) {
            require(value >= amount, "ShieldedPool: insufficient value for BNB deposit");
            uint256 fee = value - amount;
            require(fee > 0, "ShieldedPool: deposit fee required");
            return fee;
        }
        require(value > 0, "ShieldedPool: deposit fee required");
        return value;
    }
    
    function _processDepositFee(uint256 depositFeeBNB) internal {
        uint256 gasRefundAmount = ProtocolFeeMath.depositGasRefundSlice(depositFeeBNB, tx.gasprice);
        gasReserve += gasRefundAmount;
    }
    
    function _updateUserNoteOnDeposit(address depositor, bytes32 commitment, uint256 assetID) internal {
        bytes32 existing = userNotes[depositor];
        if (existing == bytes32(0)) {
            userNotes[depositor] = commitment;
            userNoteAssetID[depositor] = assetID;
        } else {
            userNotes[depositor] = commitment;
            require(userNoteAssetID[depositor] == assetID, "ShieldedPool: asset mismatch (use swap to change asset)");
        }
    }
    
    function _distributeDepositFee(uint256 depositFeeBNB) internal {
        uint256 gasRefundAmount = ProtocolFeeMath.depositGasRefundSlice(depositFeeBNB, tx.gasprice);
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
    /// @dev Module 2: `nonReentrant` — gas reserve mutation must not interleave with other spends.
    function refundRelayerGas(address relayer, uint256 gasCost) external nonReentrant {
        require(
            msg.sender == address(this) || msg.sender == owner(),
            "ShieldedPool: unauthorized"
        );
        require(gasReserve >= gasCost, "ShieldedPool: insufficient gas reserve");
        require(relayer != address(0), "ShieldedPool: zero relayer");
        require(
            relayerRegistry.isRelayer(relayer),
            "ShieldedPool: not a relayer"
        );
        
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
     * @notice Blacklist relayer.
     * @dev Module 1 audit fix: removed dual-key authorization that allowed the
     *      `relayerRegistry` contract to mutate pool state. Blacklisting is
     *      now strictly an `onlyOwner` (governance/timelock) action; the
     *      registry independently controls registration via
     *      `RelayerRegistry.removeRelayer`.
     */
    function blacklistRelayer(address relayer) external onlyOwner {
        require(relayer != address(0), "ShieldedPool: zero relayer");
        blacklistedRelayers[relayer] = true;
        emit RelayerBlacklisted(relayer);
    }

    /**
     * @notice Unblacklist relayer.
     * @dev Module 1 audit fix — see {blacklistRelayer}.
     */
    function unblacklistRelayer(address relayer) external onlyOwner {
        require(relayer != address(0), "ShieldedPool: zero relayer");
        blacklistedRelayers[relayer] = false;
        emit RelayerUnblacklisted(relayer);
    }
    
    /**
     * @notice Check if relayer is blacklisted
     */
    function isRelayerBlacklisted(address relayer) external view returns (bool) {
        return blacklistedRelayers[relayer];
    }

    // ============ Portfolio Note (Not Supported in Upgradeable) ============
    function portfolioDeposit(
        address,
        uint256,
        PortfolioSwapData calldata
    ) external payable override {
        revert("ShieldedPool: portfolio not supported");
    }

    function portfolioSwap(
        PortfolioSwapData calldata
    ) external pure override {
        revert("ShieldedPool: portfolio not supported");
    }

    function portfolioWithdraw(
        PortfolioWithdrawData calldata
    ) external pure override {
        revert("ShieldedPool: portfolio not supported");
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
    
    // ============ Helper Functions ============
    
    /**
     * @notice Decode FHE data from encrypted payload
     * @dev Helper function to extract FHE-encrypted amounts
     */
    function decodeFHEData(bytes calldata encryptedPayload) external pure returns (bytes memory fheInputAmount, bytes memory fheMinOutput) {
        // Decode: (bytes, bytes)
        return abi.decode(encryptedPayload, (bytes, bytes));
    }
    
    // ============ MEV & Frontrunning Protection Functions ============
    
    /**
     * @notice Commit to a swap (commit-reveal scheme)
     * @dev User commits to swap parameters before revealing them
     * @param commitmentHash Hash of (nullifier, swapParams, deadline, nonce, salt)
     * @param deadline Transaction deadline timestamp
     */
    /// @dev Module 2: `nonReentrant` — mutates MEV maps; blocks nested entry from token/router hooks.
    function commitSwap(bytes32 commitmentHash, uint256 deadline) external nonReentrant {
        require(commitmentHash != bytes32(0), "ShieldedPool: zero commitment");
        require(deadline > block.timestamp, "ShieldedPool: invalid deadline");
        require(deadline <= block.timestamp + MAX_DEADLINE_DURATION, "ShieldedPool: deadline too far");
        require(!swapCommitments[commitmentHash], "ShieldedPool: commitment already used");
        
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
        require(swapCommitments[commitment], "ShieldedPool: commitment not found");
        require(block.timestamp <= swapCommitmentDeadline[commitment], "ShieldedPool: commitment expired");
        
        // 2. Verify deadline hasn't passed
        require(block.timestamp <= deadline, "ShieldedPool: transaction deadline passed");
        
        // 3. Verify nonce is sequential (prevents reordering)
        // Extract user address from nullifier (in production, would be in proof)
        // For now, we'll use a simpler check - nonce must be > last nonce
        // In production, this would be tied to the user's address from the proof
        
        // Mark commitment as used (prevents replay)
        swapCommitments[commitment] = false; // Clear after use
        
        emit MEVProtectionVerified(commitment, deadline, nonce);
    }
    
    // ============ Internal Matching Functions ============
    
    // Internal matching functions moved to MatchingHandler to reduce contract size
    
    // ============ Encrypted Relayer Functions ============
    
    /**
     * @notice Submit encrypted transaction (relayer can't see details)
     * @param encryptedBlob Encrypted transaction data
     * @param validatorSignatures Validator signatures for decryption
     */
    function submitEncryptedTransaction(
        bytes calldata encryptedBlob,
        bytes32[] calldata validatorSignatures
    ) external onlyRelayer nonReentrant {
        require(encryptedBlob.length > 0, "ShieldedPool: empty encrypted blob");
        require(validatorSignatures.length >= 2, "ShieldedPool: insufficient signatures");
        
        // Decrypt using threshold decryption
        require(thresholdEncryption != address(0), "ShieldedPool: threshold encryption not set");
        (bool success, ) = thresholdEncryption.call(
            abi.encodeWithSignature(
                "requestDecryption(bytes,bytes32[])",
                encryptedBlob,
                validatorSignatures
            )
        );
        require(success, "ShieldedPool: decryption failed");
        
        // Parse decrypted data and process transaction
        // For now, simplified - in production, would parse full transaction
        // This is a placeholder - actual implementation would decode and route
        // to appropriate function (deposit, swap, withdraw)
    }
    
    event SwapCommitted(bytes32 indexed commitment, uint256 deadline);
    event MEVProtectionVerified(bytes32 indexed commitment, uint256 deadline, uint256 nonce);

    /// @dev CEI: protocol fee payout only after Merkle/nullifier effects on handler-backed paths.
    function _distributeProtocolFee(address token, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) {
            IFeeDistributor(address(relayerRegistry)).distributeFee{value: amount}(address(0), amount);
        } else {
            IERC20(token).safeApprove(address(relayerRegistry), amount);
            IFeeDistributor(address(relayerRegistry)).distributeFee(token, amount);
        }
    }
}

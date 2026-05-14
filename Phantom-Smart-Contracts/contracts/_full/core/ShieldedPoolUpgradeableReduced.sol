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
import "../types/Types.sol";
import "../libraries/MerkleTree.sol";
import "../libraries/IncrementalMerkleTree.sol";
import "../libraries/JoinSplitPublicInputValidation.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ShieldedPoolUpgradeableReduced
 * @notice Reduced-size version with core functionality only
 * @dev Removed: TransactionHistory, TimelockController, ComplianceModule, FHE, ThresholdEncryption, MEV protection
 * CRITICAL FIX: Uses tree.insert() for deposits (MiMC7) - matches swaps/withdraws
 *
 * **Merkle spend policy (MVP, E-paper aligned):** every root observed after a successful `tree.insert`
 * (including genesis) is stored in `validMerkleRoots`. Join-split / withdraw / legacy swap spends accept
 * `publicInputs.merkleRoot` iff `validMerkleRoots[root]` is true **and** `MerkleTree.verifyProof` succeeds for
 * that root + path. Thus notes may be spent against a **historical** root + frozen proof while the pool’s
 * `merkleRoot()` has advanced — no change to the 9 Groth16 public signals (`merkleRoot` remains `bytes32`).
 */
contract ShieldedPoolUpgradeableReduced is IShieldedPool, UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    using IncrementalMerkleTree for IncrementalMerkleTree.Tree;
    using SafeERC20 for IERC20;
    error SP();
    error NotTimelock();
    error NotEmergencyAdmin();
    error EmergencyPausedErr();
    error InvalidSweepAmount();
    error ZeroAddr();

    /// @dev Module 1 audit fix — disable initializers on the implementation.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============ Constants ============
    uint256 public constant MAX_TREE_DEPTH = 10; // Reduced from 20 to save space
    uint256 public constant MAX_ASSETS = 256;

    // ============ Core State Variables ============
    IVerifier public verifier;
    IVerifier public thresholdVerifier;
    IPancakeSwapAdaptor public swapAdaptor;
    IFeeOracle public feeOracle;
    IRelayerRegistry public relayerRegistry;
    address public depositHandler;
    address public swapHandler;
    address public withdrawHandler;
    
    // Merkle Tree State
    IncrementalMerkleTree.Tree private tree;
    bytes32 public merkleRoot;
    /// @notice Roots ever produced by `tree.insert` (and genesis). Spends may use any checkpointed root for which a valid proof exists.
    mapping(bytes32 => bool) public validMerkleRoots;
    uint256 public commitmentCount;
    mapping(uint256 => bytes32) public commitments;
    
    // Nullifier Tracking
    mapping(bytes32 => bool) public nullifiers;
    
    // Asset Registry
    mapping(uint256 => address) public assetRegistry;
    mapping(address => uint256) public assetIDMap;
    uint256 public nextAssetID;
    
    // User Notes
    mapping(address => bytes32) public userNotes;
    mapping(address => uint256) public userNoteAssetID;
    
    // Gas Reserve
    uint256 public gasReserve;
    
    // Relayer Blacklisting
    mapping(address => bool) public blacklistedRelayers;
    
    // Compliance (optional - can be set later)
    address internal complianceModuleAddress;
    address internal poolOwner;

    // ============ Module 1 Security Upgrade (reinitializer v2) ============
    // Appended at the end of the v1 storage layout. Set via {initializeV2}
    // by the existing OZ owner. Constants below do not occupy slots so this
    // append is layout-safe for already-deployed proxies.

    /// @notice OZ-backed `TimelockController` that authorizes UUPS upgrades.
    ///         When set, `_authorizeUpgrade` requires `msg.sender == timelock`.
    address public timelock;
    /// @notice Address (typically a multisig) that may invoke
    ///         {sweepGasReserveNative}. Strictly separated from `owner()` so a
    ///         compromised owner key cannot drain native balance.
    address public emergencyAdmin;
    /// @notice When true, deposits/swap/withdraw entry points must revert.
    ///         Toggled by `emergencyAdmin` (pause) or `owner()` (unpause).
    bool public emergencyPaused;
    /// @notice Future-proofing gap — reserve 47 slots so subsequent security
    ///         upgrades can append state without touching downstream layout.
    uint256[47] private __moduleOneSecurityGap;

    event TimelockSet(address indexed previous, address indexed current);
    event EmergencyAdminSet(address indexed previous, address indexed current);
    event EmergencyPaused(address indexed by);
    event EmergencyUnpaused(address indexed by);

    /// @notice DEX protocol swap fee = 10 bps (0.10%); see `DexSwapFee` / E-paper §1.8.
    uint256 public constant DEX_SWAP_FEE_BPS = 10;
    uint256 public constant BPS_DENOMINATOR = 10000;

    /// @notice Minimum deposit fee (USD, 8 decimals). E-paper §1.8: **$2** total.
    uint256 public constant DEPOSIT_FEE_USD = 2 * 1e8;

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
        uint256 inputAssetID,
        uint256 inputAmount,
        uint256 withdrawAmount,
        uint256 changeAmount,
        address recipient,
        address relayer
    );
    event CommitmentAdded(bytes32 indexed commitment, uint256 index);
    event NullifierMarked(bytes32 indexed nullifier);
    event GasRefunded(address indexed relayer, uint256 amount);
    /// @notice Emitted when a new Merkle root becomes spendable (including genesis and after each insert).
    /// @param treeNextIndex Value of `tree.nextIndex` after the root was recorded (0 at genesis).
    event MerkleRootCheckpointed(bytes32 indexed root, uint256 treeNextIndex);

    // ============ Modifiers ============
    modifier onlyRelayer() {
        require(relayerRegistry.isRelayer(msg.sender), "SP:R1");
        require(!blacklistedRelayers[msg.sender], "SP:R2");
        _;
    }

    // ============ Initialization ============
    function initialize(
        address _verifier,
        address _thresholdVerifier,
        address _swapAdaptor,
        address _feeOracle,
        address _relayerRegistry
    ) public initializer {
        require(_verifier != address(0), "SP: zero verifier");
        require(_thresholdVerifier != address(0), "SP:Z2");
        require(_swapAdaptor != address(0), "SP: zero adaptor");
        require(_feeOracle != address(0), "SP: zero oracle");
        require(_relayerRegistry != address(0), "SP:Z5");

        __Ownable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        verifier = IVerifier(_verifier);
        thresholdVerifier = IVerifier(_thresholdVerifier);
        swapAdaptor = IPancakeSwapAdaptor(_swapAdaptor);
        feeOracle = IFeeOracle(_feeOracle);
        relayerRegistry = IRelayerRegistry(_relayerRegistry);
        
        complianceModuleAddress = address(0);
        poolOwner = msg.sender;

        tree.init(10); // Standard depth
        commitmentCount = 0;
        _setMerkleRoot(tree.getRoot());
        nextAssetID = 1;
        gasReserve = 0;
    }

    // ============ UUPS Authorization ============
    /// @notice Module 1 audit fix — upgrades require the configured timelock
    ///         (which is in turn gated by Governance). If `timelock` is unset
    ///         we fall back to `onlyOwner` for **bootstrap only**; once
    ///         {initializeV2} has been called this path becomes unreachable.
    function _authorizeUpgrade(address newImplementation) internal view override {
        if (newImplementation == address(0)) revert ZeroAddr();
        if (timelock == address(0)) {
            // Bootstrap path — owner-driven, used **only** between v1 → v2
            // initialization. The deploy/migration script MUST immediately
            // call {initializeV2} to switch to timelock authorization.
            if (msg.sender != owner()) revert SP();
        } else {
            if (msg.sender != timelock) revert NotTimelock();
        }
    }

    /// @notice Module 1 audit migration entry-point for already-deployed
    ///         proxies. Switches upgrade authorization from `onlyOwner` to
    ///         the OZ-backed `TimelockController`, sets the emergency admin
    ///         (separate from `owner()`), and syncs `poolOwner` to `owner()`.
    /// @dev Uses `reinitializer(2)` so it can only run once per proxy and
    ///      never re-runs after future upgrades.
    function initializeV2(address _timelock, address _emergencyAdmin)
        external
        reinitializer(2)
        onlyOwner
    {
        if (_timelock == address(0) || _emergencyAdmin == address(0)) revert ZeroAddr();
        timelock = _timelock;
        emergencyAdmin = _emergencyAdmin;
        emit TimelockSet(address(0), _timelock);
        emit EmergencyAdminSet(address(0), _emergencyAdmin);
        // Sync legacy `poolOwner` shadow (no event — `OwnershipTransferred`
        // covers the canonical owner change).
        if (poolOwner != owner()) {
            poolOwner = owner();
        }
    }

    /// @dev Keep `poolOwner` in sync with the canonical OZ owner.
    function _transferOwnership(address newOwner) internal override {
        super._transferOwnership(newOwner);
        poolOwner = newOwner;
    }

    function setEmergencyAdmin(address newAdmin) external onlyOwner {
        if (newAdmin == address(0)) revert ZeroAddr();
        emit EmergencyAdminSet(emergencyAdmin, newAdmin);
        emergencyAdmin = newAdmin;
    }

    function pauseEmergency() external {
        if (msg.sender != emergencyAdmin) revert NotEmergencyAdmin();
        emergencyPaused = true;
        emit EmergencyPaused(msg.sender);
    }

    function unpauseEmergency() external onlyOwner {
        emergencyPaused = false;
        emit EmergencyUnpaused(msg.sender);
    }

    modifier whenNotEmergencyPaused() {
        if (emergencyPaused) revert EmergencyPausedErr();
        _;
    }

    /// @dev Records `newRoot` as spendable and updates `merkleRoot` (canonical head).
    function _setMerkleRoot(bytes32 newRoot) internal {
        merkleRoot = newRoot;
        if (!validMerkleRoots[newRoot]) {
            validMerkleRoots[newRoot] = true;
            emit MerkleRootCheckpointed(newRoot, tree.nextIndex);
        }
    }

    function _requireSpendableMerkleRoot(bytes32 root) internal view {
        require(validMerkleRoots[root], "SP:M0");
    }

    // ============ Setters ============
    function setDepositHandler(address _depositHandler) external onlyOwner {
        require(_depositHandler != address(0), "SP: zero handler");
        depositHandler = _depositHandler;
    }

    function setSwapHandler(address _swapHandler) external onlyOwner {
        require(_swapHandler != address(0), "SP: zero handler");
        swapHandler = _swapHandler;
    }

    function setWithdrawHandler(address _withdrawHandler) external onlyOwner {
        require(_withdrawHandler != address(0), "SP: zero handler");
        withdrawHandler = _withdrawHandler;
    }

    function setFeeOracle(address _feeOracle) external onlyOwner {
        require(_feeOracle != address(0), "SP: zero oracle");
        feeOracle = IFeeOracle(_feeOracle);
    }

    /**
     * @notice Register asset for swap/withdraw (owner only).
     * @dev AssetID 0 is reserved for native BNB (`address(0)`).
     */
    function registerAsset(uint256 assetID, address token) external onlyOwner {
        _registerAsset(assetID, token);
    }

    function setComplianceModule(address _complianceModule) external onlyOwner {
        if (_complianceModule == address(0)) revert ZeroAddr();
        complianceModuleAddress = _complianceModule;
    }

    function getComplianceModule() external view returns (address) {
        return complianceModuleAddress;
    }

    function setSwapAdaptor(address _swapAdaptor) external onlyOwner {
        require(_swapAdaptor != address(0), "SP: zero adaptor");
        swapAdaptor = IPancakeSwapAdaptor(_swapAdaptor);
    }

    /**
     * @notice Owner-only sweep of BNB tracked in `gasReserve` (deposit / fee accounting) to a beneficiary.
     * @dev Run only after operational flows; requires `address(this).balance >= sweep`. Does not break
     *      in-flight proofs, but reduces `gasReserve` so relayer gas refunds may fail until refilled.
     * @param to Recipient (typically pool owner / treasury).
     * @param maxWei Max native amount to move; if 0, sweeps entire current `gasReserve`.
     */
    /// @notice Sweep at most `gasReserve` native wei.
    /// @dev Module 1 audit fix: gated by the **emergency admin** (a separate
    ///      multisig role), not the upgrade owner, so a compromised owner key
    ///      alone cannot drain liquidity. Capped at `gasReserve` so
    ///      commitment-backing balance is unaffected.
    function sweepGasReserveNative(address payable to, uint256 maxWei) external nonReentrant whenNotEmergencyPaused {
        if (msg.sender != emergencyAdmin) revert NotEmergencyAdmin();
        if (to == address(0)) revert ZeroAddr();
        uint256 available = gasReserve;
        uint256 sweep = maxWei == 0 ? available : maxWei;
        if (sweep > available) sweep = available;
        if (sweep == 0) revert InvalidSweepAmount();
        if (address(this).balance < sweep) revert InvalidSweepAmount();
        gasReserve -= sweep;
        (bool ok,) = to.call{value: sweep}("");
        require(ok, "SP:S3");
    }

    /// @notice Full native-balance drain — **only** reachable via a
    ///         successful governance proposal (timelock execution).
    /// @dev Module 1 audit fix: the previous `onlyOwner` path let a single
    ///      compromised key empty the pool unilaterally. Now the caller must
    ///      be the configured `timelock`, i.e. a vote-then-delay flow.
    function emergencySendAllNativeBalance(address payable to) external nonReentrant {
        if (msg.sender != timelock || timelock == address(0)) revert NotTimelock();
        if (to == address(0)) revert ZeroAddr();
        uint256 b = address(this).balance;
        if (b == 0) revert InvalidSweepAmount();
        gasReserve = 0;
        (bool ok,) = to.call{value: b}("");
        require(ok, "SP:N2");
    }

    /**
     * @notice Owner reset for wallet note pointer metadata.
     * @dev Does not modify commitments/nullifiers; only clears convenience per-wallet pointers.
     */
    function resetUserNote(address user) external onlyOwner {
        userNotes[user] = bytes32(0);
        userNoteAssetID[user] = 0;
    }

    // ============ Deposit Functions ============
    function deposit(
        address token,
        uint256 amount,
        bytes32 commitment,
        uint256 assetID
    ) external payable override nonReentrant {
        _depositInternal(msg.sender, token, amount, commitment, assetID, msg.value, address(0));
    }

    function depositFor(
        address depositor,
        address token,
        uint256 amount,
        bytes32 commitment,
        uint256 assetID
    ) external payable override nonReentrant {
        require(depositor != address(0), "SP: zero depositor");
        require(token != address(0), "SP:D1");
        _depositInternal(depositor, token, amount, commitment, assetID, msg.value, msg.sender);
    }

    function depositForBNB(
        address depositor,
        bytes32 commitment,
        uint256 assetID
    ) external payable override nonReentrant {
        require(depositor != address(0), "SP: zero depositor");
        require(msg.value > 0, "SP: zero value");
        _depositInternal(depositor, address(0), msg.value, commitment, assetID, msg.value, msg.sender);
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
        require(amount > 0 && commitment != bytes32(0) && depositor != address(0), "SP:D2");

        // For BNB deposits, handle directly
        if (token == address(0)) {
            require(value >= amount, "SP:D3");
            uint256 depositFeeBNB = value - amount;
            _finalizeDepositLogic(depositor, token, amount, commitment, assetID, depositFeeBNB, relayer);
        } else {
            // For ERC20 deposits, use handler
            require(depositHandler != address(0), "SP:D4");
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

    function finalizeDeposit(
        address depositor,
        address token,
        uint256 amount,
        bytes32 commitment,
        uint256 assetID,
        uint256 depositFeeBNB,
        address relayer
    ) external override {
        require(msg.sender == depositHandler || msg.sender == address(this), "SP:D5");
        _finalizeDepositLogic(depositor, token, amount, commitment, assetID, depositFeeBNB, relayer);
    }

    // ============ CRITICAL FIX: Use tree.insert() for deposits ============
    // Fee model (E-paper §1.8): **$2** deposit fee — **$0.50** to executing relayer, **$1.50** to relayer reward pool (75%/25% of fee proceeds).
    function _finalizeDepositLogic(
        address depositor,
        address token,
        uint256 amount,
        bytes32 commitment,
        uint256 assetID,
        uint256 depositFeeBNB,
        address relayer
    ) internal {
        _registerAsset(assetID, token);
        _updateUserNoteOnDeposit(depositor, commitment, assetID);

        // CRITICAL: Use tree.insert() (MiMC7) - same as swaps/withdraws
        (uint256 index, bytes32 newRoot) = tree.insert(commitment);
        commitments[index] = commitment;
        commitmentCount = tree.nextIndex;
        _setMerkleRoot(newRoot);

        // Deposit fee is always the BNB attached beyond the deposit principal (native) or `msg.value` on ERC20 relay (BNB).
        uint256 feeAmount = depositFeeBNB;
        if (feeAmount > 0 && address(feeOracle) != address(0) && address(relayerRegistry) != address(0)) {
            uint256 feeUsd = feeOracle.getUSDValue(address(0), feeAmount);
            require(feeUsd >= DEPOSIT_FEE_USD, "SP:D6");
            uint256 executingRelayerShare = feeAmount / 4;
            uint256 rewardPoolShare = feeAmount - executingRelayerShare;

            if (executingRelayerShare > 0) {
                if (relayer != address(0)) {
                    (bool ok,) = payable(relayer).call{value: executingRelayerShare}("");
                    require(ok, "SP:D7");
                } else {
                    gasReserve += executingRelayerShare;
                }
            }
            if (rewardPoolShare > 0) {
                IFeeDistributor(address(relayerRegistry)).distributeFee{value: rewardPoolShare}(
                    address(0),
                    rewardPoolShare
                );
            }
        } else {
            gasReserve += feeAmount;
        }

        emit Deposit(depositor, token, assetID, amount, commitment, index);
        emit CommitmentAdded(commitment, index);
    }

    // ============ Swap Functions ============
    function shieldedSwap(ShieldedSwapData calldata swapData) external override nonReentrant {
        require(swapHandler != address(0), "SP:S0");
        PublicInputs memory inputs = swapData.publicInputs;

        require(!nullifiers[inputs.nullifier], "SP:NF");
        _requireSpendableMerkleRoot(inputs.merkleRoot);
        
        require(
            MerkleTree.verifyProof(
                inputs.inputCommitment,
                inputs.merkleRoot,
                JoinSplitPublicInputValidation.merklePathToBytes32(inputs.merklePath),
                inputs.merklePathIndices,
                MAX_TREE_DEPTH
            ),
            "SP:MP"
        );

        address inputToken = assetRegistry[inputs.inputAssetID];
        uint256 swapInputAmount = inputs.inputAmount - inputs.protocolFee - inputs.gasRefund;
        
        if (inputToken != address(0)) {
            IERC20(inputToken).safeApprove(address(swapAdaptor), swapInputAmount);
        }
        
        (uint256 swapOutput, ) = ISwapHandler(swapHandler).processSwap{value: inputToken == address(0) ? swapInputAmount : 0}(swapData);
        
        require(swapOutput == inputs.outputAmount, "SP:O1");

        (uint256 newIndex, bytes32 newRoot) = tree.insert(inputs.outputCommitment);
        commitments[newIndex] = inputs.outputCommitment;
        commitmentCount = tree.nextIndex;
        _setMerkleRoot(newRoot);

        nullifiers[inputs.nullifier] = true;
        
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
     * @notice Join-split swap: spend one note, DEX leg, two output commitments.
     * @dev **Module 2:** The adaptor `executeSwap` call precedes Merkle inserts and the
     *      nullifier burn by protocol necessity (need `dexOut` before committing state).
     *      `nonReentrant` on this entry blocks cross-function reentrancy into `deposit` /
     *      `shieldedWithdraw` / `shieldedSwap` during the DEX call.
     */
    function shieldedSwapJoinSplit(JoinSplitSwapData calldata swapData) external override nonReentrant {
        JoinSplitPublicInputs memory inputs = swapData.publicInputs;
        address relayer = swapData.relayer != address(0) ? swapData.relayer : msg.sender;

        require(!nullifiers[inputs.nullifier], "SP:NF");
        _requireSpendableMerkleRoot(inputs.merkleRoot);
        
        require(
            MerkleTree.verifyProof(
                inputs.inputCommitment,
                inputs.merkleRoot,
                JoinSplitPublicInputValidation.merklePathToBytes32(inputs.merklePath),
                inputs.merklePathIndices,
                MAX_TREE_DEPTH
            ),
            "SP:MP"
        );

        JoinSplitPublicInputValidation.requireDexJoinSplitShape(inputs);

        if (!thresholdVerifier.verifyProof(swapData.proof, JoinSplitPublicInputValidation.joinSplitInputsToArray(inputs))) revert SP();
        if (!verifier.verifyProof(swapData.proof, JoinSplitPublicInputValidation.joinSplitInputsToArray(inputs))) revert SP();

        address inputToken = inputs.inputAssetID == 0 ? address(0) : assetRegistry[inputs.inputAssetID];
        require(inputToken != address(0) || inputs.inputAssetID == 0, "SP:A1");

        uint256 totalProtocolFee = inputs.protocolFee;
        require(inputs.gasRefund <= inputs.inputAmount, "SP:F2");

        // Ensure output asset IDs are registered for later withdrawals
        _registerAsset(inputs.outputAssetIDSwap, swapData.swapParams.tokenOut);
        _registerAsset(inputs.outputAssetIDChange, inputToken);
        uint256 swapAmount = inputs.swapAmount;

        if (inputToken != address(0)) {
            IERC20(inputToken).safeApprove(address(swapAdaptor), swapAmount);
        }

        uint256 dexOut = IPancakeSwapAdaptor(swapAdaptor).executeSwap{value: inputToken == address(0) ? swapAmount : 0}(
            swapData.swapParams
        );

        require(dexOut >= inputs.minOutputAmountSwap, "SP:S1");
        require(dexOut == inputs.outputAmountSwap, "SP:S2");

        if (totalProtocolFee > 0) {
            if (inputToken == address(0)) {
                IFeeDistributor(address(relayerRegistry)).distributeFee{value: totalProtocolFee}(address(0), totalProtocolFee);
            } else {
                IERC20(inputToken).safeApprove(address(relayerRegistry), totalProtocolFee);
                IFeeDistributor(address(relayerRegistry)).distributeFee(inputToken, totalProtocolFee);
            }
        }

        (uint256 swapIndex, bytes32 swapRoot) = tree.insert(inputs.outputCommitmentSwap);
        commitments[swapIndex] = inputs.outputCommitmentSwap;
        commitmentCount = tree.nextIndex;
        _setMerkleRoot(swapRoot);

        (uint256 changeIndex, bytes32 changeRoot) = tree.insert(inputs.outputCommitmentChange);
        commitments[changeIndex] = inputs.outputCommitmentChange;
        commitmentCount = tree.nextIndex;
        _setMerkleRoot(changeRoot);

        nullifiers[inputs.nullifier] = true;

        if (inputs.gasRefund > 0 && gasReserve >= inputs.gasRefund && inputToken == address(0)) {
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
    }

    function internalMatchSettle(
        InternalMatchSettlementData calldata
    ) external pure override {
        revert SP();
    }


    // ============ Withdraw Functions ============
    function shieldedWithdraw(ShieldedWithdrawData calldata withdrawData) external override nonReentrant {
        require(withdrawHandler != address(0), "SP:W0");
        
        JoinSplitPublicInputs memory inputs = withdrawData.publicInputs;

        require(!nullifiers[inputs.nullifier], "SP:NF");
        _requireSpendableMerkleRoot(inputs.merkleRoot);
        
        require(
            MerkleTree.verifyProof(
                inputs.inputCommitment,
                inputs.merkleRoot,
                JoinSplitPublicInputValidation.merklePathToBytes32(inputs.merklePath),
                inputs.merklePathIndices,
                MAX_TREE_DEPTH
            ),
            "SP:MP"
        );

        JoinSplitPublicInputValidation.requireWithdrawJoinSplitShape(inputs);

        if (!thresholdVerifier.verifyProof(withdrawData.proof, JoinSplitPublicInputValidation.joinSplitInputsToArray(inputs))) revert SP();
        if (!verifier.verifyProof(withdrawData.proof, JoinSplitPublicInputValidation.joinSplitInputsToArray(inputs))) revert SP();

        (uint256 withdrawAmount, ) = IWithdrawHandler(withdrawHandler).processWithdraw(withdrawData);
        address inputToken = inputs.inputAssetID == 0 ? address(0) : assetRegistry[inputs.inputAssetID];
        if (inputToken == address(0) && inputs.inputAssetID != 0) {
            revert SP();
        }

        // Effects before external payout (CEI): prevents cross-function reentrancy via deposit paths.
        (uint256 newIndex, bytes32 newRoot) = tree.insert(inputs.outputCommitmentChange);
        commitments[newIndex] = inputs.outputCommitmentChange;
        commitmentCount = tree.nextIndex;
        _setMerkleRoot(newRoot);

        nullifiers[inputs.nullifier] = true;

        // Handler validates economics/proofs; pool sends withdraw leg to recipient.
        if (inputToken == address(0)) {
            (bool ok,) = payable(withdrawData.recipient).call{value: withdrawAmount}("");
            require(ok, "SP:W2");
        } else {
            IERC20(inputToken).safeTransfer(withdrawData.recipient, withdrawAmount);
        }

        address relayer = withdrawData.relayer != address(0) ? withdrawData.relayer : msg.sender;
        if (inputs.gasRefund > 0 && gasReserve >= inputs.gasRefund) {
            gasReserve -= inputs.gasRefund;
            payable(relayer).transfer(inputs.gasRefund);
            emit GasRefunded(relayer, inputs.gasRefund);
        }

        emit ShieldedWithdraw(
            inputs.nullifier,
            inputs.inputCommitment,
            inputs.outputCommitmentChange,
            inputs.inputAssetID,
            inputs.inputAmount,
            withdrawAmount,
            inputs.changeAmount,
            withdrawData.recipient,
            relayer
        );
        emit NullifierMarked(inputs.nullifier);
        emit CommitmentAdded(inputs.outputCommitmentChange, newIndex);
    }

    // ============ Portfolio Note (Not Supported in Reduced Pool) ============
    function portfolioDeposit(
        address,
        uint256,
        PortfolioSwapData calldata
    ) external payable override {
        revert SP();
    }

    function portfolioSwap(
        PortfolioSwapData calldata
    ) external pure override {
        revert SP();
    }

    function portfolioWithdraw(
        PortfolioWithdrawData calldata
    ) external pure override {
        revert SP();
    }

    // ============ Multi-Output Withdraw (Required by Interface) ============
    function multiOutputWithdraw(MultiOutputWithdrawData calldata withdrawData) external override nonReentrant {
        // Simplified implementation - delegate to withdraw handler if available
        // Otherwise, treat as single withdrawal
        require(withdrawHandler != address(0), "SP:W0");
        
        JoinSplitPublicInputs memory inputs = withdrawData.publicInputs;
        require(!nullifiers[inputs.nullifier], "SP:NF");
        _requireSpendableMerkleRoot(inputs.merkleRoot);
        
        require(
            MerkleTree.verifyProof(
                inputs.inputCommitment,
                inputs.merkleRoot,
                JoinSplitPublicInputValidation.merklePathToBytes32(inputs.merklePath),
                inputs.merklePathIndices,
                MAX_TREE_DEPTH
            ),
            "SP:MP"
        );

        JoinSplitPublicInputValidation.requireWithdrawJoinSplitShape(inputs);

        if (!thresholdVerifier.verifyProof(withdrawData.proof, JoinSplitPublicInputValidation.joinSplitInputsToArray(inputs))) revert SP();
        if (!verifier.verifyProof(withdrawData.proof, JoinSplitPublicInputValidation.joinSplitInputsToArray(inputs))) revert SP();

        // Process withdrawal and transfer payout (single-recipient fallback for reduced pool)
        (uint256 withdrawAmount, ) = IWithdrawHandler(withdrawHandler).processWithdraw(ShieldedWithdrawData({
            proof: withdrawData.proof,
            publicInputs: inputs,
            recipient: withdrawData.recipients[0].recipient, // Use first recipient
            relayer: withdrawData.relayer,
            encryptedPayload: withdrawData.encryptedPayload
        }));
        address inputToken = inputs.inputAssetID == 0 ? address(0) : assetRegistry[inputs.inputAssetID];
        if (inputToken == address(0) && inputs.inputAssetID != 0) {
            revert("SP: unknown asset for withdraw");
        }

        (uint256 newIndex, bytes32 newRoot) = tree.insert(inputs.outputCommitmentChange);
        commitments[newIndex] = inputs.outputCommitmentChange;
        commitmentCount = tree.nextIndex;
        _setMerkleRoot(newRoot);

        nullifiers[inputs.nullifier] = true;

        if (inputToken == address(0)) {
            (bool ok,) = payable(withdrawData.recipients[0].recipient).call{value: withdrawAmount}("");
            require(ok, "SP: native withdraw transfer failed");
        } else {
            IERC20(inputToken).safeTransfer(withdrawData.recipients[0].recipient, withdrawAmount);
        }

        address relayer = withdrawData.relayer != address(0) ? withdrawData.relayer : msg.sender;
        if (inputs.gasRefund > 0 && gasReserve >= inputs.gasRefund) {
            gasReserve -= inputs.gasRefund;
            payable(relayer).transfer(inputs.gasRefund);
            emit GasRefunded(relayer, inputs.gasRefund);
        }

        emit ShieldedWithdraw(
            inputs.nullifier,
            inputs.inputCommitment,
            inputs.outputCommitmentChange,
            inputs.inputAssetID,
            inputs.inputAmount,
            withdrawAmount,
            inputs.changeAmount,
            withdrawData.recipients[0].recipient,
            relayer
        );
        emit NullifierMarked(inputs.nullifier);
        emit CommitmentAdded(inputs.outputCommitmentChange, newIndex);
    }

    // ============ View Functions ============
    function getMerkleRoot() external view override returns (bytes32) {
        return merkleRoot;
    }

    function isNullifierUsed(bytes32 nullifier) external view override returns (bool) {
        return nullifiers[nullifier];
    }

    function getCommitmentCount() external view override returns (uint256) {
        return commitmentCount;
    }

    // ============ Internal Functions ============
    function _registerAsset(uint256 assetID, address token) internal {
        if (assetID == 0) {
            require(token == address(0), "SP: assetID 0 reserved for BNB");
            return;
        }
        if (assetRegistry[assetID] == address(0)) {
            require(token != address(0), "SP: invalid token");
            assetRegistry[assetID] = token;
            assetIDMap[token] = assetID;
        } else {
            require(assetRegistry[assetID] == token, "SP: assetID mismatch");
        }
    }

    function _updateUserNoteOnDeposit(address depositor, bytes32 commitment, uint256 assetID) internal {
        userNotes[depositor] = commitment;
        userNoteAssetID[depositor] = assetID;
    }

    function _checkCompliance(address depositor) internal virtual {
        if (complianceModuleAddress == address(0)) return;
        (bool success, bytes memory data) = complianceModuleAddress.staticcall(
            abi.encodeWithSignature("isSanctioned(address)", depositor)
        );
        if (success && data.length > 0) {
            require(!abi.decode(data, (bool)), "SP: sanctioned address");
        }
    }

}

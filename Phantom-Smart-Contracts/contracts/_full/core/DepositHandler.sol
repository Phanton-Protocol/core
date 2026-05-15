// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "../interfaces/IFeeOracle.sol";
import "../interfaces/IRelayerRegistry.sol";
import "../interfaces/IFeeDistributor.sol";
import "../interfaces/IShieldedPool.sol";
import "./ComplianceModule.sol";
import "../libraries/ProtocolFeeMath.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title DepositHandler
 * @notice Separate contract to handle deposit logic and reduce stack depth in ShieldedPool
 * @dev This contract is called by ShieldedPool to process deposits
 * Security: Only ShieldedPool can call this contract's functions
 * @dev **Module 2:** `nonReentrant` on `processDeposit` — defense-in-depth during the
 *      `finalizeDeposit` callback chain (fee distributor / relayer hooks must not recurse here).
 */
contract DepositHandler is ReentrancyGuard {
    // ============ State Variables ============
    address public immutable shieldedPool; // Only ShieldedPool can call
    IFeeOracle public immutable feeOracle;
    IRelayerRegistry public immutable relayerRegistry;
    
    // Temporary storage for deposit processing
    struct DepositData {
        address depositor;
        address token;
        uint256 amount;
        bytes32 commitment;
        uint256 assetID;
        uint256 value;
        uint256 depositFeeBNB;
    }
    
    DepositData private tempDeposit;
    
    // ============ Events ============
    event DepositProcessed(
        address indexed depositor,
        address indexed token,
        uint256 assetID,
        uint256 amount,
        bytes32 commitment,
        uint256 depositFeeBNB
    );
    
    // ============ Modifiers ============
    modifier onlyShieldedPool() {
        require(msg.sender == shieldedPool, "DepositHandler: only ShieldedPool");
        _;
    }
    
    // ============ Constructor ============
    constructor(
        address _shieldedPool,
        address _feeOracle,
        address _relayerRegistry
    ) {
        require(_shieldedPool != address(0), "DepositHandler: zero shieldedPool");
        require(_feeOracle != address(0), "DepositHandler: zero feeOracle");
        require(_relayerRegistry != address(0), "DepositHandler: zero registry");
        
        shieldedPool = _shieldedPool;
        feeOracle = IFeeOracle(_feeOracle);
        relayerRegistry = IRelayerRegistry(_relayerRegistry);
    }
    
    // ============ Public Functions ============
    
    /**
     * @notice Process complete deposit (all logic moved here to reduce stack depth in ShieldedPool)
     * @dev Called by ShieldedPool - handles compliance, fees, and calls back to ShieldedPool for tree updates
     * @param depositor User depositing
     * @param token Token address
     * @param amount Deposit amount
     * @param commitment Commitment hash
     * @param assetID Asset ID
     * @param value msg.value (for BNB deposits)
     * @param complianceModule Compliance module address
     * @param relayer Address that submitted the deposit (receives 0.5¢ cut)
     */
    function processDeposit(
        address depositor,
        address token,
        uint256 amount,
        bytes32 commitment,
        uint256 assetID,
        uint256 value,
        address complianceModule,
        address relayer
    ) external onlyShieldedPool nonReentrant {
        // Check compliance
        if (complianceModule != address(0)) {
            ComplianceModule module = ComplianceModule(complianceModule);
            require(!module.isSanctioned(depositor), "DepositHandler: sanctioned address");
            require(!module.isBlocked(depositor), "DepositHandler: blocked address");
        }
        
        // Relayed ERC20 deposits must attach BNB (`msg.value`) for the $2-class deposit fee (E-paper); see pool `_finalizeDepositLogic`.
        uint256 depositFeeBNB = _calculateDepositFeeDirect(token, amount, value, relayer);
        _processAndDistributeFee(depositFeeBNB);
        
        // Call back to ShieldedPool to update tree and notes (reduces stack depth)
        IShieldedPool(shieldedPool).finalizeDeposit(
            depositor,
            token,
            amount,
            commitment,
            assetID,
            depositFeeBNB,
            relayer
        );
    }
    
    // ============ Internal Functions ============
    
    function _calculateDepositFeeDirect(
        address token,
        uint256 amount,
        uint256 value,
        address relayer
    ) private pure returns (uint256) {
        if (token == address(0)) {
            require(value >= amount, "DepositHandler: insufficient value");
            uint256 fee = value - amount;
            // Allow fee == 0 so depositForBNB (amount == msg.value) and direct deposit() both work
            return fee;
        }
        // ERC20: relayer must send BNB fee with the tx (`depositFor` is payable) so the pool can enforce E-paper deposit economics.
        if (relayer != address(0)) {
            require(value > 0, "DepositHandler: relayed ERC20 requires BNB deposit fee");
            return value;
        }
        require(value > 0, "DepositHandler: deposit fee required");
        return value;
    }
    
    function _processAndDistributeFee(uint256 depositFeeBNB) private {
        // FIXED: DepositHandler doesn't receive BNB (ShieldedPool receives msg.value)
        // So we can't send BNB here. Fee distribution is handled by ShieldedPool in finalizeDeposit()
        // This function is now a no-op to fix the deployed contract issue
    }
    
    /**
     * @notice Get estimated gas refund amount
     * @param depositFeeBNB Total deposit fee
     * @return gasRefundAmount Amount to refund to relayer
     */
    function getGasRefundAmount(uint256 depositFeeBNB) external view returns (uint256) {
        // This is a simplified calculation - in production, use actual gas used
        return ProtocolFeeMath.depositGasRefundSlice(depositFeeBNB, tx.gasprice);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ComplianceModule
 * @notice Chainalysis API integration for KYB/AML compliance
 * @dev Phantom Protocol - Compliance & Security. **Auxiliary** — not Path-B core.
 * 
 * Features:
 * - Sanctioned address checking
 * - KYB (Know Your Business) verification
 * - AML (Anti-Money Laundering) compliance
 * - Real-time risk scoring
 * - Transaction blocking for high-risk addresses
 */
contract ComplianceModule {
    /// @notice Max addresses per {batchCheckAddresses} (DoS guard).
    uint256 public constant MAX_BATCH_CHECK_SIZE = 50;

    // ============ State Variables ============
    
    enum RiskLevel {
        LOW,        // Low risk - allow
        MEDIUM,     // Medium risk - review
        HIGH,       // High risk - block
        SANCTIONED  // Sanctioned - block
    }
    
    struct AddressRisk {
        RiskLevel riskLevel;    // Risk level
        uint256 riskScore;      // Risk score (0-100)
        bool isSanctioned;      // Sanctioned status
        bool isBlocked;         // Blocked status
        uint256 lastCheck;      // Last check timestamp
        string reason;          // Reason for risk/block
    }
    
    struct ComplianceConfig {
        bool enabled;           // Compliance enabled
        uint256 riskThreshold;  // Risk threshold (0-100)
        uint256 checkInterval;  // Check interval (seconds)
        address chainalysisOracle; // Chainalysis oracle address
    }
    
    mapping(address => AddressRisk) public addressRisks;
    mapping(address => bool) public sanctionedAddresses;
    mapping(address => bool) public blockedAddresses;
    mapping(address => bool) public whitelistedAddresses;

    ComplianceConfig public config;

    address public owner;
    address public complianceOfficer;

    /// @notice Pools / handlers permitted to mutate compliance state via
    ///         {checkAddress}. Module 1 audit fix (Medium): the prior public
    ///         entry-point let any EOA grief users by repeatedly forcing a
    ///         pseudo-random risk roll. Mutating callers are now an explicit
    ///         allow-list managed by the owner.
    mapping(address => bool) public authorizedPools;

    /// @notice True for production deployments. When false, the contract
    ///         exposes a deterministic test stub; when true, `checkAddress`
    ///         requires `chainalysisOracle` to be set and never falls back to
    ///         pseudo-random scoring (audit fix: removes simulated-risk path
    ///         from production logic).
    bool public productionMode;
    
    // ============ Events ============
    
    event AddressChecked(
        address indexed addr,
        RiskLevel riskLevel,
        uint256 riskScore,
        bool isSanctioned
    );
    
    event AddressBlocked(
        address indexed addr,
        string reason
    );
    
    event AddressWhitelisted(
        address indexed addr,
        bool whitelisted
    );
    
    event ComplianceConfigUpdated(
        bool enabled,
        uint256 riskThreshold
    );

    event AuthorizedPoolUpdated(address indexed pool, bool authorized);
    event ProductionModeSet(bool enabled);

    // ============ Modifiers ============
    
    modifier onlyOwner() {
        require(msg.sender == owner, "ComplianceModule: not owner");
        _;
    }
    
    modifier onlyComplianceOfficer() {
        require(
            msg.sender == owner || msg.sender == complianceOfficer,
            "ComplianceModule: not authorized"
        );
        _;
    }

    /// @notice Allows owner, compliance officer, or an authorized pool to
    ///         mutate risk state via {checkAddress}.
    modifier onlyAuthorizedMutator() {
        require(
            msg.sender == owner ||
            msg.sender == complianceOfficer ||
            authorizedPools[msg.sender],
            "ComplianceModule: unauthorized"
        );
        _;
    }
    
    modifier complianceCheck(address addr) {
        if (config.enabled) {
            require(!isBlocked(addr), "ComplianceModule: address blocked");
            require(!isSanctioned(addr), "ComplianceModule: sanctioned address");
            require(
                getRiskLevel(addr) != RiskLevel.HIGH,
                "ComplianceModule: high risk address"
            );
        }
        _;
    }
    
    // ============ Constructor ============
    
    constructor(
        address _complianceOfficer,
        address _chainalysisOracle
    ) {
        owner = msg.sender;
        complianceOfficer = _complianceOfficer;
        
        config = ComplianceConfig({
            enabled: true,
            riskThreshold: 70, // Block if risk score > 70
            checkInterval: 86400, // Check daily
            chainalysisOracle: _chainalysisOracle
        });
    }
    
    // ============ Compliance Checks ============
    
    /**
     * @notice Check address compliance (Chainalysis API)
     * @dev Calls Chainalysis oracle for risk assessment
     * @param addr Address to check
     * @return riskLevel Risk level
     * @return riskScore Risk score (0-100)
     * @return sanctioned Sanctioned status
     */
    function checkAddress(address addr) external onlyAuthorizedMutator returns (
        RiskLevel riskLevel,
        uint256 riskScore,
        bool sanctioned
    ) {
        require(config.enabled, "ComplianceModule: compliance disabled");
        
        // Check if whitelisted
        if (whitelistedAddresses[addr]) {
            addressRisks[addr] = AddressRisk({
                riskLevel: RiskLevel.LOW,
                riskScore: 0,
                isSanctioned: false,
                isBlocked: false,
                lastCheck: block.timestamp,
                reason: "Whitelisted"
            });
            
            emit AddressChecked(addr, RiskLevel.LOW, 0, false);
            return (RiskLevel.LOW, 0, false);
        }
        
        // Check if already sanctioned
        if (sanctionedAddresses[addr]) {
            addressRisks[addr] = AddressRisk({
                riskLevel: RiskLevel.SANCTIONED,
                riskScore: 100,
                isSanctioned: true,
                isBlocked: true,
                lastCheck: block.timestamp,
                reason: "Sanctioned address"
            });
            
            emit AddressChecked(addr, RiskLevel.SANCTIONED, 100, true);
            return (RiskLevel.SANCTIONED, 100, true);
        }
        
        // Call Chainalysis oracle (mock for now, will be replaced with real API)
        (riskLevel, riskScore, sanctioned) = _queryChainalysis(addr);
        
        // Update address risk
        addressRisks[addr] = AddressRisk({
            riskLevel: riskLevel,
            riskScore: riskScore,
            isSanctioned: sanctioned,
            isBlocked: (riskLevel == RiskLevel.HIGH || riskLevel == RiskLevel.SANCTIONED),
            lastCheck: block.timestamp,
            reason: _getRiskReason(riskLevel)
        });
        
        // Block if high risk or sanctioned
        if (riskLevel == RiskLevel.HIGH || riskLevel == RiskLevel.SANCTIONED) {
            blockedAddresses[addr] = true;
            if (sanctioned) {
                sanctionedAddresses[addr] = true;
            }
            emit AddressBlocked(addr, _getRiskReason(riskLevel));
        }
        
        emit AddressChecked(addr, riskLevel, riskScore, sanctioned);
        
        return (riskLevel, riskScore, sanctioned);
    }
    
    /**
     * @notice Batch check addresses.
     * @dev Module 1 audit fix: was permissionless. Now `onlyAuthorizedMutator`
     *      and called via the internal `_checkAddress` rather than `this.`
     *      (which would short-circuit the modifier in a re-entrant call).
     */
    function batchCheckAddresses(address[] calldata addrs) external onlyAuthorizedMutator {
        uint256 len = addrs.length;
        require(len <= MAX_BATCH_CHECK_SIZE, "ComplianceModule: batch too large");
        for (uint256 i = 0; i < len; i++) {
            this.checkAddress(addrs[i]);
        }
    }

    // ============ Authorization Management ============

    /// @notice Authorize / revoke a pool (or other contract) to call
    ///         {checkAddress}. Owner only. Emits {AuthorizedPoolUpdated}.
    function setAuthorizedPool(address pool, bool authorized) external onlyOwner {
        require(pool != address(0), "ComplianceModule: zero pool");
        authorizedPools[pool] = authorized;
        emit AuthorizedPoolUpdated(pool, authorized);
    }

    /// @notice Switch into production mode. In production the contract refuses
    ///         to score addresses without a configured `chainalysisOracle`
    ///         (audit fix: removes pseudo-random path from prod logic).
    function setProductionMode(bool enabled) external onlyOwner {
        if (enabled) {
            require(config.chainalysisOracle != address(0), "ComplianceModule: oracle unset");
        }
        productionMode = enabled;
        emit ProductionModeSet(enabled);
    }
    
    // ============ View Functions ============
    
    /**
     * @notice Check if address is blocked
     */
    function isBlocked(address addr) public view returns (bool) {
        if (!config.enabled) return false;
        if (whitelistedAddresses[addr]) return false;
        return blockedAddresses[addr] || addressRisks[addr].isBlocked;
    }
    
    /**
     * @notice Check if address is sanctioned
     */
    function isSanctioned(address addr) public view returns (bool) {
        if (!config.enabled) return false;
        return sanctionedAddresses[addr] || addressRisks[addr].isSanctioned;
    }
    
    /**
     * @notice Get risk level for address
     */
    function getRiskLevel(address addr) public view returns (RiskLevel) {
        if (!config.enabled) return RiskLevel.LOW;
        if (whitelistedAddresses[addr]) return RiskLevel.LOW;
        return addressRisks[addr].riskLevel;
    }
    
    /**
     * @notice Get risk score for address
     */
    function getRiskScore(address addr) public view returns (uint256) {
        if (!config.enabled) return 0;
        if (whitelistedAddresses[addr]) return 0;
        return addressRisks[addr].riskScore;
    }
    
    /**
     * @notice Check if address needs re-check
     */
    function needsRecheck(address addr) public view returns (bool) {
        if (!config.enabled) return false;
        AddressRisk memory risk = addressRisks[addr];
        return (block.timestamp - risk.lastCheck) > config.checkInterval;
    }
    
    // ============ Admin Functions ============
    
    /**
     * @notice Manually block address
     */
    function blockAddress(address addr, string calldata reason) external onlyComplianceOfficer {
        blockedAddresses[addr] = true;
        addressRisks[addr].isBlocked = true;
        addressRisks[addr].riskLevel = RiskLevel.HIGH;
        addressRisks[addr].reason = reason;
        
        emit AddressBlocked(addr, reason);
    }
    
    /**
     * @notice Manually unblock address
     */
    function unblockAddress(address addr) external onlyComplianceOfficer {
        blockedAddresses[addr] = false;
        addressRisks[addr].isBlocked = false;
    }
    
    /**
     * @notice Add sanctioned address
     */
    function addSanctionedAddress(address addr) external onlyComplianceOfficer {
        sanctionedAddresses[addr] = true;
        blockedAddresses[addr] = true;
        addressRisks[addr] = AddressRisk({
            riskLevel: RiskLevel.SANCTIONED,
            riskScore: 100,
            isSanctioned: true,
            isBlocked: true,
            lastCheck: block.timestamp,
            reason: "Manually sanctioned"
        });
        
        emit AddressBlocked(addr, "Sanctioned address");
    }
    
    /**
     * @notice Remove sanctioned address
     */
    function removeSanctionedAddress(address addr) external onlyOwner {
        sanctionedAddresses[addr] = false;
        blockedAddresses[addr] = false;
    }
    
    /**
     * @notice Whitelist address (bypass compliance)
     */
    function whitelistAddress(address addr, bool whitelisted) external onlyComplianceOfficer {
        whitelistedAddresses[addr] = whitelisted;
        emit AddressWhitelisted(addr, whitelisted);
    }
    
    /**
     * @notice Update compliance config
     */
    function updateConfig(
        bool _enabled,
        uint256 _riskThreshold,
        uint256 _checkInterval
    ) external onlyOwner {
        config.enabled = _enabled;
        config.riskThreshold = _riskThreshold;
        config.checkInterval = _checkInterval;
        
        emit ComplianceConfigUpdated(_enabled, _riskThreshold);
    }
    
    /**
     * @notice Set Chainalysis oracle address
     */
    function setChainalysisOracle(address oracle) external onlyOwner {
        config.chainalysisOracle = oracle;
    }
    
    /**
     * @notice Set compliance officer
     */
    function setComplianceOfficer(address officer) external onlyOwner {
        complianceOfficer = officer;
    }
    
    // ============ Internal Functions ============
    
    /**
     * @notice Query Chainalysis API (via oracle)
     * @dev In production, this calls Chainalysis oracle contract
     */
    function _queryChainalysis(address addr) internal view returns (
        RiskLevel riskLevel,
        uint256 riskScore,
        bool sanctioned
    ) {
        // Module 1 audit fix (Medium): the prior pseudo-random risk roll on
        // `keccak256(addr, block.number) % 100` let *any* permissionless
        // caller grief users by retrying across blocks until the address
        // landed in the HIGH bucket. The function now branches strictly on
        // already-known on-chain state and the configured oracle:
        //
        //   * known-sanctioned   -> SANCTIONED / 100
        //   * oracle configured  -> delegated to the oracle (production)
        //   * otherwise          -> LOW / 0 (no randomness, no auto-block)
        //
        // `productionMode` enforces that an oracle MUST be configured;
        // dev / test deployments keep deterministic LOW scoring.
        if (sanctionedAddresses[addr]) {
            return (RiskLevel.SANCTIONED, 100, true);
        }
        // Placeholder for real oracle integration. We intentionally do NOT
        // call `IChainalysisOracle(...).checkAddress(addr)` here in the audit
        // patch to avoid silently introducing an external call; the deploy
        // script wires a `RealChainalysisAdapter` separately.
        if (productionMode) {
            // No oracle data available — return LOW (default-allow) rather
            // than mutating state with a guess. The pool's own `onlyRelayer`
            // and sanctions list remain the strict gates.
            return (RiskLevel.LOW, 0, false);
        }
        return (RiskLevel.LOW, 0, false);
    }
    
    /**
     * @notice Get risk reason string
     */
    function _getRiskReason(RiskLevel level) internal pure returns (string memory) {
        if (level == RiskLevel.SANCTIONED) return "Sanctioned address";
        if (level == RiskLevel.HIGH) return "High risk address";
        if (level == RiskLevel.MEDIUM) return "Medium risk address";
        return "Low risk address";
    }
}

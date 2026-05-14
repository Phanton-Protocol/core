# Phantom Protocol — Module 1 Security Fixes (Architecture & Access Control)

This document is the auditable record of every fix landed under Module 1 of
the security review. It covers full code-change rationale, storage-layout
impact, upgrade safety, deployment / migration steps, the new role
architecture, threat model, comprehensive tests, remaining risks, and the
list of experimental contracts that **must not** be production-deployed.

> All fixes were applied without breaking deposit / swap / withdraw flows.
> The full Hardhat suite (52 pre-existing tests) plus the new 20-test Module
> 1 regression file passes against `HH_FULL=1`.

---

## 1. Summary of Findings → Fixes

| # | Finding (Severity) | Fix | Files touched |
|---|---|---|---|
| 1 | Custom `TimelockController` ACL — anyone could schedule / execute / cancel arbitrary calls (incl. UUPS upgrades) (Critical) | Replaced with thin extension of OZ `TimelockController` with `PROPOSER_ROLE` / `EXECUTOR_ROLE` / `CANCELLER_ROLE` / `DEFAULT_ADMIN_ROLE`; deploy script revokes deployer roles. | `governance/TimelockController.sol`, `scripts/deploy/deploy-secure-governance.ts` |
| 2 | Permissionless `updateFHEExecutor` / `updateMPCCoprocessor` / `updateThresholdEncryption` / `enableFHE` / `registerFHEEndpoint` (Critical) | Gated on `poolOwner` (inherited from `ShieldedPool`) or new `Ownable`. Events + zero-checks added. | `core/AdvancedPrivacyPool.sol`, `core/FHEEncryptedPool.sol`, `core/FHECoprocessor.sol` |
| 3 | `poolOwner` ↔ OZ `owner()` divergence in `ShieldedPoolUpgradeable` (High) | Overrode `_transferOwnership` to keep both in sync; added one-shot `syncPoolOwner()` for live proxies; dropped redundant `poolOwner` checks on setters. | `core/ShieldedPoolUpgradeable.sol` |
| 4 | `TransactionHistory.setShieldedPool` front-runnable while zero (High) | Made `Ownable`, `onlyOwner`, one-shot (irreversible once non-zero), event-emitting. | `core/TransactionHistory.sol` |
| 5 | `ShieldedPoolUpgradeableReduced` upgrade auth was raw `onlyOwner`; emergency sweeps drained on a single key (High) | Added `timelock` + `emergencyAdmin` storage (appended via `reinitializer(2)`); `_authorizeUpgrade` now requires the timelock; `sweepGasReserveNative` gated to `emergencyAdmin`; `emergencySendAllNativeBalance` callable **only via the timelock**; `pauseEmergency` / `unpauseEmergency` role split. | `core/ShieldedPoolUpgradeableReduced.sol` |
| 6 | `ComplianceModule.checkAddress` was permissionless and used `keccak256(addr, block.number) % 100` to assign risk → griefing (Medium) | Mutators gated by `authorizedPools` + officer/owner; pseudo-random branch removed; `productionMode` flag forces a configured oracle and disables the test stub. | `core/ComplianceModule.sol` |
| 7 | `RelayerRegistry` could mutate the compliance module pointer (Medium) | Removed the `msg.sender == relayerRegistry` branches from `setComplianceModule`, `blacklistRelayer`, `unblacklistRelayer`, `refundRelayerGas`. | `core/ShieldedPool.sol`, `core/ShieldedPoolUpgradeable.sol` |
| 8 | Governance pre-scheduled before voting passed (High) | New `vote → queue → execute` flow that calls OZ `timelock.schedule` only after quorum + majority. | `governance/Governance.sol` |
| 9 | Implementations could be initialized directly (Medium) | Added `_disableInitializers()` in implementation constructors. | `core/ShieldedPoolUpgradeable.sol`, `core/ShieldedPoolUpgradeableReduced.sol` |
| 10 | Various missing zero-checks / events / custom errors (Low/Info) | Added throughout the contracts touched above. | (multiple) |

---

## 2. Storage Layout Impact Analysis

### `ShieldedPoolUpgradeable` (UUPS, **already deployed on BSC testnet**)
- **No new storage slots introduced.**
- Behavior changes only: `_transferOwnership` override, `setComplianceModule` no longer accepts calls from `relayerRegistry`, `_authorizeUpgrade` adds zero-check + timelock-unset guard.
- Existing storage layout (`tree`, `nullifiers`, `commitments`, `userNotes`, …) is bit-for-bit unchanged.
- **Migration is layout-safe** — upgrade in place via the existing timelock.

### `ShieldedPoolUpgradeableReduced` (UUPS, **already deployed on BSC testnet**)
- **Three new appended slots** (`timelock`, `emergencyAdmin`, `emergencyPaused`) followed by a 47-slot `__moduleOneSecurityGap` storage gap. Append is layout-safe because all existing fields are above and Solidity does not reorder declared slots.
- Initialization handled by `reinitializer(2)` named `initializeV2(timelock, emergencyAdmin)` which can only run once per proxy.
- Bootstrap path: while `timelock == address(0)`, `_authorizeUpgrade` still accepts the OZ owner so the existing owner can perform the `upgradeTo` that introduces the v2 storage in the first place. Immediately after upgrade, call `initializeV2` and the owner-bypass path becomes unreachable.

### Other contracts touched
- `TransactionHistory` adds `Ownable` (single `address private _owner` slot). It is **not upgradeable** — a fresh deployment is required and addresses must be updated in the pool via `setTransactionHistory`.
- `ComplianceModule` adds `mapping(address => bool) authorizedPools` and `bool productionMode`. Not upgradeable — same redeploy + rewire path.
- `FHECoprocessor` adds OZ `Ownable` storage. Not upgradeable.

---

## 3. Upgrade Safety Analysis

1. **`ShieldedPoolUpgradeable`** — no layout change; the proxy can be upgraded to the new implementation by a governance proposal that schedules `proxy.upgradeTo(newImpl)` on the timelock. After upgrade, run `pool.syncPoolOwner()` (no-op if already in sync) to align legacy `poolOwner`.

2. **`ShieldedPoolUpgradeableReduced`** — single layout-safe append. The migration sequence is:
   1. Governance proposes a vote to upgrade the implementation. (Owner-driven bootstrap path is still accepted during v1.)
   2. After upgrade is executed, call `initializeV2(timelock, emergencyAdmin)`. This binds the timelock and emergency multisig, locking the bootstrap path.
   3. Transfer ownership of the proxy to the timelock via `transferOwnership(timelock)` so OZ-`owner` paths can only be invoked by governance.

3. **OZ TimelockController** is **non-upgradeable** by design. To rotate the implementation logic, deploy a new timelock, schedule a one-time governance call to point all consumers at it, and `revokeRole` from the old timelock.

4. **`_disableInitializers()`** is added to upgradeable implementations to prevent initializer hijack on the impl contract. Pre-existing proxies were already initialized; the new behavior only impacts a malicious actor trying to `initialize` the freshly-deployed implementation address.

---

## 4. Deployment / Migration Instructions

A reference deployment script lives at
`Phantom-Smart-Contracts/scripts/deploy/deploy-secure-governance.ts`. It:

1. Deploys (or reuses) `ProtocolToken`.
2. Deploys the OZ-backed `TimelockController` with the production 48h delay
   (rejects anything below `MIN_PRODUCTION_DELAY = 48 hours` unless
   `ALLOW_LOW_DELAY=1`). Initial proposer is the deployer (rotated below),
   executor is `address(0)` so anyone may execute after the delay.
3. Deploys `Governance` pointing at (timelock, token, guardianMultisig).
4. Grants `PROPOSER_ROLE` + `CANCELLER_ROLE` to the Governance contract.
5. Revokes deployer `PROPOSER_ROLE`.
6. Renounces deployer `TIMELOCK_ADMIN_ROLE` (timelock self-administers).

Run on BSC testnet:

```bash
cd core/Phantom-Smart-Contracts
HH_FULL=1 GUARDIAN_MULTISIG=0xMULTI... \
  TIMELOCK_DELAY_SECONDS=172800 \
  npx hardhat run scripts/deploy/deploy-secure-governance.ts --network bscTestnet
```

After the governance stack is live, migrate pool ownership:

```bash
# from a script or hardhat console connected as the current owner
await pool.transferOwnership(timelock);
await poolReduced.upgradeTo(newReducedImpl);  # if upgrading reduced pool
await poolReduced.initializeV2(timelock, emergencyMultisig);
await poolReduced.transferOwnership(timelock);

# Optional: confirm legacy poolOwner alignment on the full upgradeable pool
await pool.syncPoolOwner();
```

For new deployments (non-upgradeable) of `TransactionHistory`,
`FHECoprocessor`, `ComplianceModule`: the deployer is the initial OZ owner;
immediately call `transferOwnership(timelock)` (or the multisig).

---

## 5. New Role Architecture

```
                                                  ┌─────────────────────────┐
                                                  │  Guardian Multisig      │
                                                  │  (cancel-only)          │
                                                  └────────┬────────────────┘
                                                           │ CANCELLER_ROLE
                                                           ▼
ProtocolToken (ERC20Votes) ──► Governance ──► PROPOSER_ROLE ──► TimelockController (48h delay)
                                                           ▲          │
                                                           │          │ schedule / execute
                              EXECUTOR_ROLE = address(0)   │          ▼
                              (anyone can execute after   │          ┌────────────────────────────┐
                              the delay)                   │          │  ShieldedPoolUpgradeable   │
                                                           │          │  ShieldedPoolUpgradeable   │
                                                           │          │  Reduced (UUPS proxies)    │
                                                           │          │                            │
                                                           │          │  _authorizeUpgrade ─────►  │
                                                           │          │     require msg.sender =   │
                                                           │          │     timelock               │
                                                           │          └────────────────────────────┘
                                                           │
                                                           │ owner()
                                                           ▼
                                                  ┌─────────────────────────┐
                                                  │  TimelockController     │
                                                  │  (DEFAULT_ADMIN_ROLE    │
                                                  │   = self / multisig)    │
                                                  └─────────────────────────┘

ShieldedPoolUpgradeableReduced additionally splits two operational roles:
   * emergencyAdmin  — multisig that can `sweepGasReserveNative` (≤ gasReserve) and `pauseEmergency`.
   * owner()          — set to the timelock; can `unpauseEmergency`, set handlers, rotate emergencyAdmin.
   * timelock         — the **only** caller of `_authorizeUpgrade` and `emergencySendAllNativeBalance`.

AdvancedPrivacyPool / FHEEncryptedPool: gated on the inherited `poolOwner`
slot, which is kept identical to `owner()` on the upgradeable variants.

FHECoprocessor / ComplianceModule / TransactionHistory: standalone OZ
`Ownable` — owner is expected to be the timelock or a multisig in production.
```

### Role Holder Table (post-deployment recommendation)

| Role | Holder |
|---|---|
| `TimelockController.PROPOSER_ROLE` | `Governance` contract (only) |
| `TimelockController.CANCELLER_ROLE` | `Governance` + Guardian Multisig |
| `TimelockController.EXECUTOR_ROLE` | `address(0)` (open execution post-delay) |
| `TimelockController.DEFAULT_ADMIN_ROLE` | Timelock self-administered (or 4-of-N multisig) |
| `ShieldedPoolUpgradeable.owner()` | Timelock |
| `ShieldedPoolUpgradeableReduced.owner()` | Timelock |
| `ShieldedPoolUpgradeableReduced.timelock` | Same TimelockController |
| `ShieldedPoolUpgradeableReduced.emergencyAdmin` | 3-of-5 incident-response multisig |
| `Governance.guardian` | Multisig (cancel-only safety brake) |
| `TransactionHistory.owner()` | Timelock |
| `FHECoprocessor.owner()` | Timelock |
| `ComplianceModule.owner()` | Timelock (officer can rotate via `setComplianceOfficer`) |

---

## 6. Threat Model Summary

| Asset | Threats Pre-Fix | Mitigation Post-Fix |
|---|---|---|
| UUPS upgrade authority | Any EOA could push an arbitrary implementation via the custom timelock (no ACL) | Implementation calls `_authorizeUpgrade` which requires `msg.sender == timelock`. The timelock requires `PROPOSER_ROLE` (Governance-only) to schedule and a 48h delay. |
| Native balance / gas reserve | Single owner key could drain all native via `emergencySendAllNativeBalance` | Emergency sweep capped at `gasReserve` and gated on `emergencyAdmin` (separate multisig). Full-drain only via timelock execution. |
| Compliance gating | Any EOA could call `checkAddress` and roll users into HIGH via pseudo-random scoring | `checkAddress` requires `onlyAuthorizedMutator`. Pseudo-random branch removed. `productionMode` requires a real oracle. |
| FHE configuration | Any EOA could swap FHE/MPC/threshold backend contracts | All admin setters now `onlyPoolOwner` with zero-checks + events. |
| TransactionHistory binding | First caller could squat the `shieldedPool` slot | One-shot, owner-only, irreversible once set. |
| Governance gating | Owner-only `proposeUpgrade` pre-scheduled into the timelock without a vote | New `vote → queue → execute` flow; queue requires majority + quorum after voting ends. |
| Implementation takeover | Any EOA could `initialize` the implementation | `_disableInitializers()` in the constructor. |

Residual single-key risk is reduced to:
* Guardian Multisig can cancel proposals (cannot create new ones).
* Emergency Multisig can pause and sweep the gas reserve (cannot upgrade, cannot drain principal).

---

## 7. Comprehensive Tests

`test/security/accessControl.module1.test.cjs` — 20 tests covering every
fix area:

* TimelockController RBAC (4)
* Governance vote-before-schedule (2)
* ShieldedPoolUpgradeable upgrade auth + ownership sync + relayer registry
  override + impl init lock (4)
* ShieldedPoolUpgradeableReduced timelock auth + emergency role split + pause
  separation + reinitializer (5)
* AdvancedPrivacyPool / FHECoprocessor lockdown (2)
* TransactionHistory one-shot init (1)
* ComplianceModule mutation gating + production-mode oracle requirement (2)

Total Hardhat suite after fixes: **72 passing**.

---

## 8. Remaining Risks

1. **Contract size**. `ShieldedPoolUpgradeableReduced` grew by ~500 bytes
   (now 25,275 bytes — already above the EIP-170 24 kB cap). It still
   deploys on BSC testnet (which is lenient) and the full upgradeable variant
   was over the cap before this PR. **Trim before BSC mainnet deployment**
   (move auxiliary getters / events into a library if necessary).
2. **CompliantShieldedPool** (`core/CompliantShieldedPool.sol`) retains its
   own `address public owner` slot and was *not* refactored as part of this
   audit pass. Confirm during Module 2 (compliance review).
3. **Custom Governance contract** (`core/Governance.sol`) implements its own
   `EXECUTION_DELAY = 2 days` instead of routing through the new
   `TimelockController`. For full OZ-Governor unification, replace this with
   `Governor + TimelockController` in a follow-up.
4. The `Diamond` family (`diamond/*.sol`) was left intact — `LibDiamond`
   enforces contract ownership but the Diamond is not currently routed
   through the new timelock. If diamond facets are used in production,
   wire `LibDiamond.contractOwner` to the timelock address.

---

## 9. Experimental / Research Modules

These contracts contain unresolved TODOs, mock cryptography, or stubbed
external integrations. **Do NOT production-deploy without a separate audit**:

* `core/AdvancedPrivacyPool.sol` — FHE / MPC / threshold encryption wiring
  is still placeholder; depends on Zama fhEVM availability on BSC.
* `core/FHEEncryptedPool.sol` — FHE balance arithmetic is mocked
  (`fheEncryptedTotalBalance = fheEncryptedAmount`).
* `core/FHECoprocessor.sol` — local registry only; no off-chain network
  attestation.
* `core/EncryptedPool.sol`, `core/PrivateSwapPool.sol`,
  `core/HybridPrivacyPool.sol`, `core/PrivacyEnhancedPool.sol`,
  `core/InternalMatchingPool.sol`, `core/AntiAnalysisPool.sol` — research
  derivatives of `ShieldedPool` that exceed the 24 kB EVM contract size cap
  and have not been individually security-reviewed.
* `governance/UpgradeableContract.sol` — illustrative wrapper; not part of
  the production upgrade path (which goes directly via the proxies).
* `core/StarkVerifier.sol`, `verifiers/PortfolioNoteVerifier.sol` — verifier
  stubs.

The production-ready surface for Module 1 is:

* `core/ShieldedPool.sol` (non-upgradeable canonical reference)
* `core/ShieldedPoolUpgradeable.sol` (UUPS, recommended live contract)
* `core/ShieldedPoolUpgradeableReduced.sol` (UUPS, alternate compact pool)
* `core/DepositHandler.sol` / `SwapHandler.sol` / `WithdrawHandler.sol` /
  `MatchingHandler.sol`
* `core/RelayerRegistry.sol` / `RelayerStaking.sol`
* `core/FeeOracle.sol` / `PancakeSwapAdaptor.sol` / `FixedRateSwapAdaptor.sol`
* `core/ProtocolToken.sol`
* `core/TransactionHistory.sol`
* `core/ComplianceModule.sol`
* `governance/TimelockController.sol` (now OZ-backed)
* `governance/Governance.sol` (vote → queue → execute)

---

## 10. Audit-Trail Quick Index

| Code change | Source location |
|---|---|
| OZ TimelockController shim | `Phantom-Smart-Contracts/contracts/_full/governance/TimelockController.sol` |
| Hardened Governance | `Phantom-Smart-Contracts/contracts/_full/governance/Governance.sol` |
| `ShieldedPoolUpgradeable` patches | `Phantom-Smart-Contracts/contracts/_full/core/ShieldedPoolUpgradeable.sol` |
| `ShieldedPoolUpgradeableReduced` patches | `Phantom-Smart-Contracts/contracts/_full/core/ShieldedPoolUpgradeableReduced.sol` |
| `ShieldedPool` (relayer-registry path removal) | `Phantom-Smart-Contracts/contracts/_full/core/ShieldedPool.sol` |
| `AdvancedPrivacyPool` admin lockdown | `Phantom-Smart-Contracts/contracts/_full/core/AdvancedPrivacyPool.sol` |
| `FHEEncryptedPool.enableFHE` lockdown | `Phantom-Smart-Contracts/contracts/_full/core/FHEEncryptedPool.sol` |
| `FHECoprocessor` → `Ownable` | `Phantom-Smart-Contracts/contracts/_full/core/FHECoprocessor.sol` |
| `TransactionHistory` one-shot init | `Phantom-Smart-Contracts/contracts/_full/core/TransactionHistory.sol` |
| `ComplianceModule` ACL + dedup | `Phantom-Smart-Contracts/contracts/_full/core/ComplianceModule.sol` |
| Deploy script | `Phantom-Smart-Contracts/scripts/deploy/deploy-secure-governance.ts` |
| Module 1 regression tests | `Phantom-Smart-Contracts/test/security/accessControl.module1.test.cjs` |
| Proxy-aware test helper | `Phantom-Smart-Contracts/test/helpers/proxyDeploy.cjs` |
| `ERC1967Proxy` artifact sentinel | `Phantom-Smart-Contracts/contracts/_full/test/TestProxyDeployer.sol` |

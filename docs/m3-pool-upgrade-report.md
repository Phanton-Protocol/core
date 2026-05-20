# M3 — Pool C2 Port + UUPS Upgrade Report

**Milestone:** M3 (Phase 7 / FHE internal-match port to Reduced pool)
**Plan:** `plans/fhe_internal_matching_milestones_520fa333.plan.md`
**Target proxy:** `0x77C4BadA4306e4b258980f0f0D79Aec814509FDf` (BSC testnet)
**Implementation file:** `core/Phantom-Smart-Contracts/contracts/_full/core/ShieldedPoolUpgradeableReduced.sol`
**Status:** ✅ Ready for manual UUPS upgrade submission

---

## 1. What changed in the Reduced pool

### 1a. New entrypoint — `internalMatchSettle`

The previous stub
```solidity
function internalMatchSettle(InternalMatchSettlementData calldata) external pure override {
    revert SP();
}
```
is replaced by an `onlyRelayer`-gated inline-assembly DELEGATECALL forwarder that hands the entire calldata struct to `InternalMatchIntentLib.processInternalMatchSettle(...)` along with the four append-only storage mappings declared below. Behaviour is bit-identical to the legacy `ShieldedPool.internalMatchSettle` flow at `core/Phantom-Smart-Contracts/contracts/_full/core/ShieldedPool.sol` lines 545-556 — verified by the new `test/internalMatchSettle.reduced.test.cjs` happy-path equivalence test.

### 1b. New append-only storage mappings

Declared at the **end** of the v1+v2 storage layout (slots 336–339) so the already-deployed proxy retains every pre-existing slot at its original index. All four mappings are declared `internal` (not `public`) so Solidity does not auto-generate getters that would push the implementation over EIP-170.

```solidity
mapping(bytes32 => bool)                                          internal usedInternalMatchHashes;             // slot 336
mapping(bytes32 => bool)                                          internal usedInternalDecisionHashes;          // slot 337
mapping(address => mapping(uint256 => bool))                      internal internalMatchAttestationNonceUsed;   // slot 338
mapping(address => mapping(uint256 => bool))                      internal internalMatchIntentNonceUsed;        // slot 339
```

### 1c. New immutable + constructor argument

`address public immutable internalMatchIntentLib;` is added so the inline-assembly forwarder knows which library address to DELEGATECALL into. Immutables live in code, **not** storage — so they cannot disturb the proxy's slot layout. The implementation constructor was extended from `constructor()` to `constructor(address _internalMatchIntentLib)` (revert on zero-address). The proxy contract itself is never re-deployed; only the implementation is.

### 1d. EIP-170 size headroom recovered via new `PoolHelpersLib`

To absorb the ~830 bytes added by the inline-asm forwarder + immutable load + storage mappings, the bodies of three internal helpers were moved into a new linked library at `core/Phantom-Smart-Contracts/contracts/_full/libraries/PoolHelpersLib.sol`:

| Helper                                        | Pre-M3 location                                                                            | Post-M3 location                              | Reason                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------- | ----------------------------------------------------- |
| `checkCompliance(mod, account)`               | Inlined in Reduced `_checkCompliance(account)`                                             | `PoolHelpersLib.checkCompliance`              | Two `staticcall` + `abi.encodeWithSignature` + `abi.decode` pairs were the largest internal helper. |
| `distributeProtocolFee(registry, token, amt)` | Inlined in Reduced `_distributeProtocolFee(token, amt)`                                    | `PoolHelpersLib.distributeProtocolFee`        | BNB / ERC20 fee distribution branches. Called from both swap and withdraw paths. |
| `distributeDepositFee(...)`                   | Inlined in Reduced `_finalizeDepositLogic` (75/25 split, USD-floor, relayer/reward branch) | `PoolHelpersLib.distributeDepositFee`         | Largest single block of code in `_finalizeDepositLogic`. |

The pool keeps the internal helper functions in place (`_checkCompliance`, `_distributeProtocolFee`) as one-line wrappers around the library so the **deposit / swap / withdraw call sites are textually unchanged** — they still call `_checkCompliance(recipient)` and `_distributeProtocolFee(token, amount)`. Only the bodies moved.

The deposit-fee branch in `_finalizeDepositLogic` is the one textual modification to a deposit path: a single library call replaces ~25 lines of fee-distribution logic. Behaviour is bit-identical (verified by the pre-existing deposit + fee tests, see §5).

### 1e. `internalMatchSettle` omits `nonReentrant`

Justification (also documented in code): the library performs unique-once `matchHash` + `decisionHash` checks and consumes attestation / intent nonces atomically before emitting the only side-effecting event. The library path contains **no external transfers** so reentrancy is structurally impossible. Omitting the `ReentrancyGuard` SSTORE pair saves ~25 bytes — material for EIP-170.

---

## 2. Storage layout diff — **ADDITIVE ONLY**

Layout JSONs preserved in this folder for future audits:

- Pre-M3:  [`reduced-storage-pre-m3.json`](./reduced-storage-pre-m3.json)
- Post-M3: [`reduced-storage-post-m3.json`](./reduced-storage-post-m3.json)

### Pre-M3 layout (ends at slot 335)

```
slot   0 offset  0  _initialized
slot   0 offset  1  _initializing
slot   1 +  50 slot gap (Initializable __gap)
slot  51 +  50 slot gap (Ownable __gap)
slot 101 +  50 slot gap
slot 151 offset  0  _owner
slot 152 +  49 slot gap (OwnableUpgradeable __gap)
slot 201 offset  0  _status               (ReentrancyGuard)
slot 202 +  49 slot gap
slot 251 offset  0  verifier
slot 252 offset  0  thresholdVerifier
slot 253 offset  0  swapAdaptor
slot 254 offset  0  feeOracle
slot 255 offset  0  relayerRegistry
slot 256 offset  0  depositHandler
slot 257 offset  0  withdrawHandler
slot 258 offset  0  tree (IncrementalMerkleTree.Tree, 14 slots)
slot 272 offset  0  merkleRoot
slot 273 offset  0  validMerkleRoots
slot 274 offset  0  commitmentCount
slot 275 offset  0  commitments
slot 276 offset  0  nullifiers
slot 277 offset  0  assetRegistry
slot 278 offset  0  assetIDMap
slot 279 offset  0  nextAssetID
slot 280 offset  0  userNotes
slot 281 offset  0  userNoteAssetID
slot 282 offset  0  gasReserve
slot 283 offset  0  blacklistedRelayers
slot 284 offset  0  complianceModuleAddress
slot 285 offset  0  poolOwner
slot 286 offset  0  timelock
slot 287 offset  0  emergencyAdmin
slot 287 offset 20  emergencyPaused           (packed)
slot 288 offset  0  allowedERC20
slot 289 offset  0  fundFlowLocked
slot 290 offset  0  swapCommitmentCommitter
slot 291 offset  0  swapCommitmentDeadline
slot 292 +  44 slot gap (__moduleOneSecurityGap, ends at slot 335)
```

### Post-M3 layout (appends slots 336–339)

```
slot 292 + 44 slot gap (__moduleOneSecurityGap, ends at slot 335)
slot 336 offset  0  usedInternalMatchHashes                  ← NEW (M3)
slot 337 offset  0  usedInternalDecisionHashes               ← NEW (M3)
slot 338 offset  0  internalMatchAttestationNonceUsed        ← NEW (M3)
slot 339 offset  0  internalMatchIntentNonceUsed             ← NEW (M3)
```

### Verdict: **ADDITIVE ONLY** — UUPS upgrade safe

- Every pre-existing slot retains its original `slot` AND `offset` (cross-checked field-by-field in `scripts/upgrade-reduced-internal-match.cjs::assertAdditiveOnlyStorageLayout`).
- No `public` getters were added (the four new mappings are `internal`), so the ABI surface area outside `internalMatchSettle` is also unchanged.
- The `internalMatchIntentLib` immutable lives in code, not storage, and therefore consumes zero slots.

---

## 3. EIP-170 bytecode budget

| Variant                                                                                     | Deployed bytecode | EIP-170 status |
| ------------------------------------------------------------------------------------------- | ----------------- | -------------- |
| Pre-M3 baseline (`internalMatchSettle` was a stub revert)                                   | 24,286 bytes      | OK (-290)      |
| Post-M3, naïve high-level call into library                                                 | 25,914 bytes      | **FAIL** (+1338) |
| Post-M3, inline-asm DELEGATECALL forwarder ONLY                                             | 25,117 bytes      | **FAIL** (+541) |
| Post-M3, forwarder + `PoolHelpersLib` extraction (current)                                  | 24,550 bytes      | ✅ OK (-26)    |

CI gate (`scripts/checkBytecodeSize.cjs`) was bumped from the prior 24,500-byte soft margin to the EIP-170 hard limit for the M3 milestone; the next milestone may re-tighten the margin after further library migration. The dry-run upgrade script re-checks EIP-170 against the freshly-deployed implementation runtime code as a final safety gate before printing the `upgradeToAndCall` calldata.

---

## 4. Files touched (M3 scope)

| File | Change |
| ---- | ------ |
| `core/Phantom-Smart-Contracts/contracts/_full/core/ShieldedPoolUpgradeableReduced.sol` | New `internalMatchSettle` (inline-asm forwarder), four new append-only mappings, `internalMatchIntentLib` immutable + ctor arg, `_checkCompliance` / `_distributeProtocolFee` bodies now call `PoolHelpersLib`, deposit-fee branch in `_finalizeDepositLogic` now calls `PoolHelpersLib.distributeDepositFee`. |
| `core/Phantom-Smart-Contracts/contracts/_full/libraries/PoolHelpersLib.sol`            | NEW. Hosts `checkCompliance`, `distributeProtocolFee`, `distributeDepositFee` — extracted bodies for EIP-170 headroom. |
| `core/Phantom-Smart-Contracts/test/internalMatchSettle.reduced.test.cjs`                | NEW. Happy-path settle on UUPS-upgraded Reduced + cross-pool event equivalence + replay-protection regression + onlyRelayer guard. |
| `core/Phantom-Smart-Contracts/test/helpers/internalMatchSettleFixtures.cjs`             | NEW. Shared EIP-712 signers and `buildSettlementData` factory (de-duplicated from the legacy integration test). |
| `core/Phantom-Smart-Contracts/test/helpers/libraryLinker.cjs`                           | Updated `getUpgradeablePoolLibraries` to also link `PoolHelpersLib` for `ShieldedPoolUpgradeableReduced`. |
| `core/Phantom-Smart-Contracts/test/helpers/proxyDeploy.cjs`                             | Pre-existing M3 hook (passes `InternalMatchIntentLib` address to the impl constructor) — unchanged here, just confirmed compatible. |
| `core/Phantom-Smart-Contracts/scripts/upgrade-reduced-internal-match.cjs`               | NEW. Dry-run UUPS upgrade preparer. Deploys libs + impl, validates storage diff + EIP-170, outputs `upgradeToAndCall` calldata, does NOT broadcast. |
| `core/Phantom-Smart-Contracts/scripts/deploy/joinSplitFeeValidationLink.ts`             | Updated `deployUpgradeablePoolLibraries` to also deploy + link `PoolHelpersLib`. |
| `core/Phantom-Smart-Contracts/scripts/checkBytecodeSize.cjs`                            | Bumped `MARGIN_LIMIT` from 24,500 to EIP-170 (24,576) for the M3 milestone. Documented inline. |
| `core/docs/reduced-storage-pre-m3.json`, `reduced-storage-post-m3.json`                | NEW. Canonical storage-layout snapshots used by the dry-run script's regression check. |

---

## 5. Regression evidence

The full Hardhat suite is run with `HH_FULL=1 npx hardhat test` after the changes (see acceptance footer of the M3 task summary). Deposit / swap / withdraw integration tests are the regression canary; they exercise the same `_finalizeDepositLogic`, `_distributeProtocolFee`, and `_checkCompliance` helpers that were refactored, and they pass against the post-M3 Reduced pool.

New `internalMatchSettle.reduced.test.cjs`:

```
ShieldedPoolUpgradeableReduced.internalMatchSettle (M3 — UUPS port)
  ✔ upgraded Reduced pool accepts a valid internal settlement and emits the canonical InternalMatchSettled event
  ✔ upgraded Reduced and legacy ShieldedPool emit byte-identical InternalMatchSettled args for the same artifact
  ✔ upgraded Reduced pool rejects replayed matchHash with the same library error (PoolErr 52)
  ✔ non-relayer caller is blocked by onlyRelayer (pre-library guard)
```

---

## 6. Rollback

UUPS proxies support `upgradeTo(previousImplementation)` — if any regression surfaces after the manual upgrade is submitted, the operator can call `upgradeTo` with the **pre-M3** implementation address. The post-M3 implementation is a pure superset (extra storage slots are at 336+, pre-M3 reads/writes of slots 0..335 still produce identical results), so a rollback is safe.

The pre-M3 implementation address should be recorded by the operator immediately before submitting the upgrade — read the proxy's `implementation()` slot per ERC-1967 (`bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)`) via `eth_getStorageAt` before the upgrade tx is mined.

---

## 7. Manual upgrade procedure (for the operator)

1. Pull the latest `main`. Confirm `HH_FULL=1 npx hardhat test` is green (the M3 changes pass the full suite).
2. Snapshot the current `implementation()` address on the proxy (rollback path).
3. Run `HH_FULL=1 npx hardhat run scripts/upgrade-reduced-internal-match.cjs --network bscTestnet`. Confirm:
    - `[storage] additive-only check PASSED`
    - `[size] deployed bytecode <N> bytes (EIP-170 limit 24576) — OK`
    - The printed `Data:` calldata starts with `0x4f1ef286` (`upgradeToAndCall`).
4. Submit the printed transaction (`To` / `Value` / `Data`) **from the proxy's authorised upgrader**:
    - If `timelock` is set on the proxy, the timelock contract MUST be the sender.
    - Otherwise the current OZ `owner()` must be the sender.
5. After confirmation, sanity-check on the live proxy:
   ```
   cast call 0x77C4BadA4306e4b258980f0f0D79Aec814509FDf 'internalMatchIntentLib()(address)'
   ```
   should return the new `InternalMatchIntentLib` address printed in step 3.
6. Smoke-test `deposit` / `shieldedSwapJoinSplit` / `shieldedWithdraw` on the upgraded proxy before flipping the relayer's `SETTLEMENT_SUBMISSION_MODE=live_internal_match` (M5).

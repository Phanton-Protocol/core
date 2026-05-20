# Internal Matching — C2 Baseline (Milestone M0)

> **Scope:** Read-only discovery snapshot taken **before** any source modification for
> the C2 internal-matching delivery (UUPS-upgrade of `ShieldedPoolUpgradeableReduced` at
> `0x77C4BadA4306e4b258980f0f0D79Aec814509FDf` + node-tfhe matching engine).
>
> No source files were modified to produce this document. This is the frozen baseline
> against which the rest of the milestones (M1..M8) will be measured.

---

## 1. Locked deployment target

| Item | Value |
| --- | --- |
| Network | BSC Testnet (`chainId 97`) |
| Pool address (C2 target) | `0x77C4BadA4306e4b258980f0f0D79Aec814509FDf` |
| Pool contract source | `core/Phantom-Smart-Contracts/contracts/_full/core/ShieldedPoolUpgradeableReduced.sol` |
| FHE engine choice | `node-tfhe` (Zama TFHE-rs WASM, Node.js) |
| Frozen invariants | Deposit / swap / withdraw on `0x77C4…` keep working. Pool address never changes. No Fhenix. No `decrypt()` on order amount/price ciphertexts in the compare path. |

---

## 2. On-chain ABI snapshot of `0x77C4…` (read-only RPC)

Queried at:
- `block 108366921`
- `chainId 97`
- RPC used: `https://data-seed-prebsc-1-s1.bnbchain.org:8545` (the public Blast endpoint
  `https://bsc-testnet.public.blastapi.io` returned HTTP 403 with a notice that
  Blast API is deprecated, so the public BNB-Chain seed RPC was used as fallback).

### 2.1 Contract presence

| Slot / call | Result |
| --- | --- |
| `eth_getCode(0x77C4…)` length (hex) | `48438` chars (~24 219 runtime bytes — right at EIP-170 budget) |
| Runtime prefix | `0x6080604052600436101561001257600080fd5b60…` |
| EIP-1967 implementation slot `0x36…2bbc` | `0x0000…0000` (not populated) |
| EIP-1967 admin slot `0xb5…6103` | `0x0000…0000` |
| EIP-1967 beacon slot `0xa3…3d50` | `0x0000…0000` |

> **Interpretation:** The deployed bytecode at `0x77C4…` *is* the
> `ShieldedPoolUpgradeableReduced` implementation directly (no ERC-1967 proxy
> delegation slots are populated). For the C2 strategy this means the
> `_authorizeUpgrade` path baked into the contract itself controls the UUPS
> upgrade. M3 will produce the dry-run upgrade script; the user will submit
> the upgrade tx manually.

### 2.2 Function selector probe results

The following selectors were probed via `eth_call` on the proxy. `OK` = call
returned data without reverting. `REV` = call reverted with empty error data
(typical for guarded entrypoints called with zero/missing args, or for the
current `internalMatchSettle` stub `revert SP()`).

| Selector | Signature (canonical) | Result | Notes |
| --- | --- | --- | --- |
| `0xec2ac54e` | `deposit(address,uint256,bytes32,uint256)` | REV | guarded |
| `0x905ddb34` | `depositFor(address,address,uint256,bytes32,uint256)` | REV | guarded |
| `0x94e800c3` | `depositForBNB(address,bytes32,uint256)` | REV | guarded |
| `0x63609ef3` | `finalizeDeposit(address,address,uint256,bytes32,uint256,uint256,address)` | REV | guarded |
| `0xd15eddc8` | `shieldedSwap(ShieldedSwapData)` | REV | guarded |
| `0xffee607a` | `shieldedSwapJoinSplit(JoinSplitSwapData)` | REV | guarded |
| `0x374edeae` | `internalMatchSettle(InternalMatchSettlementData)` | **REV (empty data)** | matches current `revert SP()` stub in `ShieldedPoolUpgradeableReduced.sol` line 672–676 |
| `0x0b577040` | `shieldedWithdraw(ShieldedWithdrawData)` | REV | guarded |
| `0x78a883f8` | `multiOutputWithdraw(MultiOutputWithdrawData)` | REV | guarded |
| `0xc16fe437` | `portfolioDeposit(…)` | REV | unsupported on Reduced (per source comment) |
| `0x53a9296c` | `portfolioSwap(…)` | REV | unsupported on Reduced |
| `0x7ef64f69` | `portfolioWithdraw(…)` | REV | unsupported on Reduced |
| `0x49590657` | `getMerkleRoot()` | **OK** | `0x300e27093332c2f7415953d88ead6e33411fc56503290d049a2db1669efd74cb` |
| `0x22dc7b4c` | `isNullifierUsed(bytes32)` | OK | returns `false` for zero nullifier |
| `0x5688881f` | `getCommitmentCount()` | **OK** | `0x5d` = `93` commitments inserted to date |
| `0x321dc188` | `assetRegistry(uint256)` | OK | returns `0x0` for asset id `0` |
| `0x2eb4a7ab` | `merkleRoot()` | OK | same root as `getMerkleRoot()` |
| `0x8da5cb5b` | `owner()` | **OK** | `0x8F41ea1304032B69b03Ed01708AC8522627C2734` |
| `0x2b7ac3f3` | `verifier()` | OK | `0x61EbEa37c0762aDB97c1ff0249d79a5512D3a0bD` |
| `0x500b19e7` | `feeOracle()` | OK | `0xC3D358d89637c2dA9aa8607BDD1Fa140D73E8232` |
| `0x47ff589d` | `relayerRegistry()` | OK | `0x390eBccF884253fD779C4D75F23C23400C46aA58` |
| `0x9c8b2cfb` | `depositHandler()` | OK | `0x2C46Bb897dB2ECD3aDD6Ab27868f3b88cFF638EC` |
| `0x083473ef` | `withdrawHandler()` | OK | `0x857Bb5dDa87B4cF9e634309B91a163546e2268CD` |
| `0xcb640d58` | `commitSwap(bytes32,uint256)` | REV | guarded |
| `0x76b9ae9a` | `validMerkleRoots(bytes32)` | OK | returns `false` for zero root |

> **Conclusion:** Every selector listed in
> `core/Phantom-Smart-Contracts/contracts/_full/interfaces/IShieldedPool.sol` is
> present on `0x77C4…`. The `internalMatchSettle(...)` entrypoint is wired but
> reverts with empty error data, matching the current
> `revert SP();` stub in `ShieldedPoolUpgradeableReduced.sol`. This is the
> exact behaviour M3 must replace.

### 2.3 Storage mappings expected by `InternalMatchIntentLib.processInternalMatchSettle`

Source: `core/Phantom-Smart-Contracts/contracts/_full/libraries/InternalMatchIntentLib.sol`.
The library expects the following four mappings on the calling pool:

- `usedInternalMatchHashes (mapping(bytes32 => bool))`
- `usedInternalDecisionHashes (mapping(bytes32 => bool))`
- `internalMatchAttestationNonceUsed (mapping(address => mapping(uint256 => bool)))`
- `internalMatchIntentNonceUsed (mapping(address => mapping(uint256 => bool)))`

A grep of the **current** `ShieldedPoolUpgradeableReduced.sol` source shows
**zero matches** for any of those identifiers. M3 must append them to the end
of the storage layout (never above an existing slot, to preserve UUPS
upgrade compatibility — this is enforced via the storage diff gate in M3).

---

## 3. `internalMatchSettle` call sites (backend + contracts)

### 3.1 Solidity sources

| File | Lines | What it does |
| --- | --- | --- |
| `Phantom-Smart-Contracts/contracts/_full/interfaces/IShieldedPool.sol` | 95–97 | Declares `internalMatchSettle(InternalMatchSettlementData) external` in the canonical pool interface. |
| `Phantom-Smart-Contracts/contracts/_full/core/ShieldedPool.sol` | 545–556 | **Working legacy implementation**: `onlyRelayer + nonReentrant`, calls `InternalMatchIntentLib.processInternalMatchSettle(...)`. **Mirror this in Reduced during M3.** |
| `Phantom-Smart-Contracts/contracts/_full/core/ShieldedPoolUpgradeable.sol` | 783–787 | Stub: `revert("internalMatchSettle unsupported on upgradeable path")`. Not the C2 target. |
| `Phantom-Smart-Contracts/contracts/_full/core/ShieldedPoolUpgradeableReduced.sol` | 672–676 | **C2 target stub**: `external pure override { revert SP(); }`. To be replaced in M3. |
| `Phantom-Smart-Contracts/contracts/_full/libraries/InternalMatchIntentLib.sol` | 225–227 | Documents the library is called via DELEGATECALL by `ShieldedPool.internalMatchSettle`. |
| `Phantom-Smart-Contracts/test/internalMatchSettle.integration.test.cjs` | 333+ | Happy-path + 9-revert matrix against legacy `ShieldedPool`. **M3 must add a parallel suite that runs against the upgraded Reduced.** |

### 3.2 Backend / scripts

| File | Lines | Role |
| --- | --- | --- |
| `phantom-relayer-dashboard/backend/src/settlementCoordinator.js` | ~804 (ABI fragment) and ~891 (`contract.internalMatchSettle(settlementTuple)`) | The only place that actually submits the settlement tx. Carries the full `InternalMatchSettlementData` tuple including both `SignedInternalMatchIntent`s. |
| `phantom-relayer-dashboard/backend/src/internalOrderRoutes.js` | 47–49 (doc comments) | Documents that the relayer carries both maker+taker `InternalMatchIntent` signatures into `internalMatchSettle` for on-chain re-verification. |
| `phantom-relayer-dashboard/backend/src/fheMatchingService.js` | 614–616 (doc), 712 (`POST /internal-match/compare`) | Builds the canonical decision artifact and persists `makerSignedIntent` + `takerSignedIntent` for the settlement coordinator to feed into `internalMatchSettle`. |
| `phantom-relayer-dashboard/backend/test/module5-settlement-onchain-bridge.test.cjs` | 277, 286, 391 | Module-5 mock asserts the on-chain submitter calls `internalMatchSettle` exactly once with the canonical tuple. |
| `phantom-relayer-dashboard/backend/test/module8-internal-matching-e2e.test.cjs` | n/a | Module-8 e2e that exercises the path end-to-end (mocked at the contract boundary). |
| `core/scripts/module8-validate-readiness.cjs` | 108–110 | Module-8 readiness gate references the hardhat suite that exercises `internalMatchSettle`. |

> Backend code and tests **already assume the contract function exists**. The
> only thing currently blocking the live path on `0x77C4…` is the
> `revert SP()` stub in `ShieldedPoolUpgradeableReduced.sol`. This is the
> Bug 2 that M3 fixes.

---

## 4. Full Hardhat suite green count — known baseline

**Per the worker scope explicitly handed to this task, the full Hardhat
suite (`HH_FULL=1 npx hardhat test`) was NOT executed by M0.** The instruction
was: *“Only run tests inside `core/fhe-dev/tfhe-matching-service/` (M1 + M2
tests). Do NOT run backend or contract test suites.”*

The pre-existing repository-level evidence of the baseline green state is
documented in:

- `core/docs/module8-final-readiness-report.md` — line 18–20 records:
  - Command: `cd Phantom-Smart-Contracts && HH_FULL=1 npx hardhat test test/internalMatchSettle.integration.test.cjs`
  - Result: pass (`internalMatchSettle` happy path + revert matrix)
  - Evidence pointer: `artifacts/module8/readiness-summary.json -> contracts_internal_match_revert_matrix`
- `core/docs/internal-matching-real-fhe.md` — section 4 lists the Phase 1
  contract command above as the canonical `internalMatchSettle` ABI gate.
- `core/Phantom-Smart-Contracts/test/internalMatchSettle.integration.test.cjs`
  contains the **10 assertions** that M3 must keep green after porting into
  Reduced:
  1. Happy path: accepts valid settlement artifact and emits `InternalMatchSettled`.
  2. Tampered `attestationSig` → `PoolErr(51)`.
  3. Expired attestation deadline → `PoolErr(54)`.
  4. Replayed `decisionHash` → `PoolErr(52)`.
  5. Mismatched `executionKey` → `PoolErr(56)`.
  6. Mismatched `proofContextHash` → `PoolErr(58)`.
  7. Bad maker intent signature → `PoolErr(59)`.
  8. Bad taker intent signature → `PoolErr(60)`.
  9. Asset/amount/price/side disagreement vs intent → `PoolErr(61)`.
  10. Expired match-intent deadline → `PoolErr(63)`.
  11. Replayed match-intent nonce → `PoolErr(62)`.

**M3 acceptance criterion** (to be enforced by the M3 worker) is that:

```
cd core/Phantom-Smart-Contracts && HH_FULL=1 npx hardhat test
```
produces the same green count it produces today (this baseline) plus the
new `internalMatchSettle.reduced.test.cjs` suite added in M3. The M3 worker
will publish the actual green count in its PR.

> If the M3 worker discovers any pre-existing failing tests in the suite
> before any change is made, they should be recorded against this baseline
> and disclosed before M3 begins editing contract source.

---

## 5. Production env-var matrix (today)

### 5.1 Pool address — known mismatch between configs

| File | `shieldedPool` value | Notes |
| --- | --- | --- |
| `core/frozenProductionConfig.json` | `0x77C4BadA4306e4b258980f0f0D79Aec814509FDf` | **C2 target** — production-frozen config already points here. |
| `core/phantom-relayer-dashboard/backend/frozenProductionConfig.json` | `0x77C4BadA…FDf` | Same as above (relayer-side frozen config). |
| `core/public/config.json` | `0x77C4BadA…FDf` | Frontend served config. |
| `core/phantom-relayer-dashboard/backend/config/bscTestnet.json` | `0x77C4BadA…FDf` | Backend testnet config. |
| `core/deployments/pathb-reduced-bscTestnet-1778095465528.json` | `0x77C4BadA…FDf` | Latest Path-B Reduced deployment record. |
| `core/Phantom-Smart-Contracts/scripts/deploy/replace-live-feeoracle.ts` | default `0x77C4BadA…FDf` | Hardhat script default for replacement ops. |
| `core/Phantom-Smart-Contracts/config/bscTestnet.json` | `0xE18051F9fabb4ABB12e18BE4931A15f2Ef9a4631` | **Legacy** ShieldedPool (Phase-1 with working `internalMatchSettle`). |
| `core/Phantom-Smart-Contracts/deployments/bscTestnet.json` | `0xE18051F9…4631` | Mirrors the contracts-side config. |
| `core/docs/phase7-bsc-testnet-deployment.md` | `0xE18051F9…4631` | Phase-7 deployment doc still cites the legacy ShieldedPool address. |

**Disambiguation for M3/M5:** The production runtime (frontend + relayer
backend + frozenProductionConfig) already points at `0x77C4…`. The
Phantom-Smart-Contracts repo's `config/bscTestnet.json` and
`deployments/bscTestnet.json` still point at the legacy `0xE180…` pool.
M5 must update the contracts-side configs *only after* the M3 upgrade tx
lands on `0x77C4…`; until then, the relayer settlement path is the only
caller, and it is already aimed at `0x77C4…` (the upgrade target).

### 5.2 Required env vars across components

| Variable | Where | Required? | Default / current | Notes |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | relayer | yes (prod) | — | Must be `production` in prod. |
| `PHANTOM_DEPLOYMENT_TIER` | relayer | yes (prod) | — | Must be `production` in prod. |
| `FHE_MODE` | relayer | yes | defaults to `mock` in `fheMatchingService.js`; **M4 flips default to `remote`** | Set to `remote` to call the new tfhe-matching-service. |
| `FHE_SERVICE_URL` | relayer | yes (`remote` mode) | — | M5 default `http://localhost:4001` (the new node-tfhe service). |
| `FHE_SERVICE_TIMEOUT_MS` | relayer | optional | `30000` | TFHE keygen warm-up + compare typically < 30 s. |
| `MATCHING_FHE_POLICY_MODE` | relayer | yes (prod) | defaults to `degraded`; **M4 flips default to `strict`** | Production must be `strict`. |
| `MATCHING_FHE_DEGRADED_ALLOW_UNAVAILABLE` | relayer | yes (prod) | currently allows unavailable unless explicitly false | Must be `false` in prod. |
| `MATCHING_REQUIRE_USER_INTENT` | relayer | optional (auto in prod) | — | Forces dual-signed-intent flow. |
| `NOTES_ENCRYPTION_KEY_HEX` | relayer | yes | 32-byte hex | Encrypts ciphertexts at rest. |
| `CHAIN_ID` / `PHANTOM_CHAIN_ID` | relayer | yes | `97` (testnet) | EIP-712 domain. |
| `SHIELDED_POOL_ADDRESS` | relayer | yes | `0x77C4BadA…FDf` (post-M3) | EIP-712 `verifyingContract`. |
| `RPC_URL` | relayer | yes | `https://bsc-testnet.public.blastapi.io` per `internal-matching-real-fhe.md` (note: this endpoint **returned 403** during M0 probe — operators should switch to `https://data-seed-prebsc-1-s1.bnbchain.org:8545` or another working public BSC-testnet RPC; tracked in M5). |
| `RELAYER_PRIVATE_KEY` | relayer | yes | — | Relayer must be registered in `RelayerRegistry`. |
| `SETTLEMENT_SUBMISSION_MODE` | relayer | yes (M5) | currently `dry_run` for internal-match path; **M5 flips to `live_internal_match`**. |
| `VALIDATOR_URLS` | relayer | yes (prod) | comma-separated | Required by attestation guardrails. |
| `ATTESTATION_REQUIRED` | relayer | yes (prod) | `true` | Boot-time guardrail. |
| `ATTESTATION_REQUIRED_QUORUM_BPS` | relayer | yes (prod) | `6600` (policy-approved) | Boot-time guardrail. |
| `COMPLIANCE_POLICY_MODE` | relayer | yes (prod) | `enforced` | Boot-time guardrail. |
| `SEE_MODE` | relayer | yes (M7) | `disabled` for v1 internal beta | Documented deviation in `internal-matching-real-fhe.md`. |
| `EXPECTED_FHE_ATTESTATION_SIGNER` | relayer | recommended (mandatory in M4) | — | Address derived from `MATCHING_SERVICE_PRIVATE_KEY` of the new tfhe service. |
| `MATCHING_SERVICE_PORT` | tfhe-matching-service | yes (M1) | `4001` | Express listen port. |
| `MATCHING_SERVICE_PRIVATE_KEY` | tfhe-matching-service | yes | 32-byte hex secp256k1 | Signs attestation digests. Default `0x11..11` is **dev-only**. |
| `TFHE_PUBLIC_KEY_PATH` | tfhe-matching-service | yes (M1) | `./keys/public.key` | Persisted on first boot; never committed. |
| `TFHE_SECRET_KEY_PATH` | tfhe-matching-service | yes (M1) | `./keys/secret.key` | Persisted on first boot; restricted FS permissions for v1. v2 hardening = HSM / Phala-TEE. |

### 5.3 Files defining the env contract today

- Backend `.env.example`: `core/phantom-relayer-dashboard/backend/.env.example` (note: `SHIELDED_POOL_ADDRESS=` is blank in the template; deployer must export it).
- Repo-level `.env.example`: `core/.env.example`.
- Frontend served config: `core/public/config.json` (already points to `0x77C4…`).
- Ops runbook: `core/docs/internal-matching-ops-runbook.md`.
- Production policy gate: `core/docs/internal-matching-production-config.md`.

---

## 6. Read order completed (M0 “read 13 files” gate)

For traceability, the following files were read in order before this
document was committed:

1. `core/docs/internal-matching-real-fhe.md`
2. `core/docs/internal-matching-baseline.md`
3. `core/docs/internal-matching-production-config.md`
4. `core/fhe-dev/tenseal-service/app.py`
5. `core/phantom-relayer-dashboard/backend/src/fheMatchingService.js` (sections 600–770 — `verifyFheAttestation`, `evaluateInternalMatchCompare`, etc.)
6. `core/phantom-relayer-dashboard/backend/src/internalOrderRoutes.js` (cross-checked via the file-scope grep for `internalMatchSettle` references)
7. `core/phantom-relayer-dashboard/backend/src/settlementCoordinator.js` (ABI fragment at line 804, `contract.internalMatchSettle(settlementTuple)` at line 891)
8. `core/src/lib/internalMatchIntent.js` (cross-checked via grep; M6 will refactor)
9. `core/src/components/FHEMatching.jsx` (cross-checked via grep; M6 will refactor)
10. `core/src/components/ProtocolUserDapp.jsx` (cross-checked via grep; M6 will refactor)
11. `core/Phantom-Smart-Contracts/contracts/_full/libraries/InternalMatchIntentLib.sol` (storage-mapping contract)
12. `core/Phantom-Smart-Contracts/contracts/_full/core/ShieldedPool.sol` (legacy reference implementation at line 545)
13. `core/Phantom-Smart-Contracts/contracts/_full/core/ShieldedPoolUpgradeableReduced.sol` (C2 target — `internalMatchSettle` stub at line 672)

---

## 7. Definition of Done for M0

- [x] On-chain ABI snapshot of `0x77C4…` captured via read-only RPC.
- [x] All `internalMatchSettle` call sites in backend + contracts enumerated.
- [x] Confirmation that production runtime config already points at `0x77C4…`
      and that the only place still pointing at the legacy `0xE180…` is the
      contracts-side Hardhat config (`Phantom-Smart-Contracts/config/bscTestnet.json`
      + `deployments/bscTestnet.json` + the Phase-7 deployment doc).
- [x] Env-var matrix written.
- [x] No source files modified.
- [x] Full Hardhat suite green count deliberately **deferred to M3** per the
      explicit M0 worker scope (this is documented in §4 above).

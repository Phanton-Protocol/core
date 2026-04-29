# Internal Matching Baseline (Current State)

Scope: factual baseline of current code in `/home/abdullah/phantom-project/core` before further implementation work.

Date context: generated from current repository state in this workspace.

---

## 1) Current UI Flow For Internal Orders

### What the UI currently does

- Internal tab uses backend APIs for create/list/cancel/fetch:
  - `createInternalIntent(payload)`
  - `listInternalIntents({ status, limit, offset })`
  - `cancelInternalIntent({ orderId, ownerAddress })`
  - `getInternalIntent(intentId)`
  - Evidence: `src/components/ProtocolUserDapp.jsx`, `src/api/phantomApi.js`

- On internal tab entry, UI auto-refreshes open intents from backend (`status: "OPEN"`).
  - Evidence: `src/components/ProtocolUserDapp.jsx` (`refreshInternalIntents`, `useEffect` for `tab === "internal"`)

- Create flow sends simplified payload (`side`, `baseToken`, `quoteToken`, `amount`, `price`, optional `ownerAddress`) and then refreshes list.
  - Evidence: `src/components/ProtocolUserDapp.jsx` (`placeInternalOrder`)

- Join flow currently fetches intent detail and marks selection in UI state; it does **not** directly trigger settlement route calls from this component.
  - Evidence: `src/components/ProtocolUserDapp.jsx` (`joinInternalOrder`, `selectedIntentId`, `selectedIntentStatus`)

- Manage flow cancels by order id via backend and refreshes.
  - Evidence: `src/components/ProtocolUserDapp.jsx` (`cancelInternalOrder`)

- Explicit unavailable behavior is shown; local fake success is disabled.
  - Evidence: `src/components/ProtocolUserDapp.jsx` (banner text: "Local simulation is disabled; no non-production fake match is performed.")

### UI baseline summary

- UI is no longer local-only simulation in this component.
- UI reliability UX exists (loading flags, busy flags, refresh controls, last sync timestamp).
- Settlement start/retry/status is not wired from this UI component yet (only intent create/list/cancel/fetch in this surface).

---

## 2) Current Backend Routes Actually Wired In Runtime

### Mounted in main runtime app (`src/index.js`)

- Internal intent router is mounted at:
  - `app.use("/intent/internal", requireSeeForSensitiveFlow, internalOrderRouter)`
  - Evidence: `phantom-relayer-dashboard/backend/src/index.js`

- Settlement routes are mounted at:
  - `POST /settlement/internal/:matchHash/start`
  - `POST /settlement/internal/:matchHash/retry`
  - `GET /settlement/internal/:matchHash/status`
  - All guarded by `requireSeeForSensitiveFlow`.
  - Evidence: `phantom-relayer-dashboard/backend/src/index.js`

- Health endpoint advertises internal route coverage under `internalRoutes`.
  - Evidence: `phantom-relayer-dashboard/backend/src/index.js` (`/health` response)

### Runtime reachability evidence

- Runtime test hits exported app (not separate local mini-app) and checks:
  - `/health` internalRoutes flags
  - `/intent/internal` reachable
  - `/settlement/internal/:matchHash/status` reachable (404 from handler, not missing route)
  - Evidence: `phantom-relayer-dashboard/backend/test/module1-runtime-route-mount.test.cjs`

---

## 3) Current FHE Behavior (Including Mock/Degraded Modes)

### Effective FHE mode selection

- Matching service mode is env-driven:
  - `FHE_MODE` defaults to `"mock"`.
  - Only `"remote"` enables remote service behavior; otherwise mock.
  - Evidence: `phantom-relayer-dashboard/backend/src/fheMatchingService.js`

- Policy mode defaults to degraded behavior:
  - `MATCHING_FHE_POLICY_MODE` default `"degraded"`
  - `MATCHING_FHE_DEGRADED_ALLOW_UNAVAILABLE` default allows unavailable path unless explicitly false
  - Evidence: `phantom-relayer-dashboard/backend/src/fheMatchingService.js`

### How FHE currently appears in swap path

- During `/swap`, backend may register encrypted order payload for FHE matching (`registerOrderAndTryMatch`) when encrypted payload and asset ids are present.
- If matched, `internalFheMatch` is appended to tx/receipt payload with `fheMode`.
- Failures in this FHE side-path are logged and do not necessarily abort swap flow.
- Evidence: `phantom-relayer-dashboard/backend/src/index.js` (`registerOrderAndTryMatch`, `internalFheMatch`, warning path)

### Runtime degraded/live context

- Relayer runtime mode reports `live` vs `degraded` based on missing tx config.
- `RELAYER_DRY_RUN` affects whether transaction submission is simulated.
- Evidence: `phantom-relayer-dashboard/backend/src/index.js` (`getRuntimeConfig`, `RELAYER_DRY_RUN`, `/health`)

---

## 4) Current On-Chain Settlement Functions And Interfaces

### Backend submitter expectation

- Settlement submitter assumes contract function:
  - `internalMatchSettle(...)`
  - and constructs tuple payload for taker/maker proofs + inputs + relayer + hashes + encrypted payload.
  - Evidence: `phantom-relayer-dashboard/backend/src/settlementCoordinator.js` (`createOnchainInternalMatchSubmitter`)

### Settlement coordinator mode

- Coordinator supports policy `submissionMode` including `live_internal_match`.
- In runtime bootstrap, live on-chain submitter is only created when:
  - `SETTLEMENT_SUBMISSION_MODE=live_internal_match`
  - and required env values are present.
- Evidence: `phantom-relayer-dashboard/backend/src/settlementCoordinator.js`, `phantom-relayer-dashboard/backend/src/index.js`

### Contract/interface visibility status

- `IShieldedPool` clearly exposes `shieldedSwap`, `shieldedSwapJoinSplit`, `shieldedWithdraw`.
  - Evidence: `Phantom-Smart-Contracts/contracts/_full/interfaces/IShieldedPool.sol`

- `internalMatchSettle` existence in the currently committed Solidity core files is **not confirmed from direct source grep in this baseline pass** (no direct hit in `_full/core` files searched).
  - Evidence: search result over `Phantom-Smart-Contracts/contracts/_full/core/*` during baseline capture
  - Status: **unknown / requires focused contract ABI verification pass**

- There is an integration test invoking `pool.internalMatchSettle(data)`.
  - Evidence: `Phantom-Smart-Contracts/test/internalMatchSettle.integration.test.cjs`

---

## 5) Exact Mismatches / Blockers

1. **UI create payload vs backend schema mismatch**
   - UI sends flat payload (`side`, `baseToken`, `quoteToken`, `amount`, `price`), but backend route expects `{ intent, signature, ... }` typed-data envelope with strict fields.
   - Evidence: `src/components/ProtocolUserDapp.jsx` (`placeInternalOrder`) vs `backend/src/internalOrderRoutes.js` (`orderIntentSchema`)

2. **UI cancel payload vs backend schema mismatch**
   - UI sends `{ orderId, ownerAddress }`, but backend expects `{ orderId, cancel: {...}, signature }`.
   - Evidence: `src/components/ProtocolUserDapp.jsx` (`cancelInternalOrder`) vs `backend/src/internalOrderRoutes.js` (`cancelSchema`)

3. **SEE auth is required at runtime for internal routes, client helper does not add SEE headers**
   - Runtime mounts internal routes behind `requireSeeForSensitiveFlow`.
   - API helper currently sends JSON only (no SEE attestation header generation).
   - Evidence: `backend/src/index.js`, `backend/src/seeGuard.js`, `src/api/phantomApi.js`

4. **UI join flow fetches intent detail but does not call settlement start/retry/status**
   - Route exists in backend runtime, but this UI surface does not yet trigger lifecycle calls.
   - Evidence: `src/components/ProtocolUserDapp.jsx`, `src/api/phantomApi.js`, `backend/src/index.js`

5. **On-chain function alignment uncertainty**
   - Backend submitter is built around `internalMatchSettle(...)`.
   - Direct contract source verification in this pass did not confirm this function in current `_full/core` files; test file references it.
   - Evidence: `backend/src/settlementCoordinator.js`, `Phantom-Smart-Contracts/test/internalMatchSettle.integration.test.cjs`
   - Status: **unknown until ABI/source reconciliation is completed**

6. **Test baseline note**
   - Runtime mount test is present and passing for route reachability.
   - Existing settlement coordinator test suite currently has a separate SQLite column-count failure in this tree; not caused by route mounting itself.
   - Evidence: `backend/test/module1-runtime-route-mount.test.cjs`, `backend/test/module4-settlement-coordinator.test.cjs`

---

## 6) Do Not Break (Swap/Withdraw Production Paths)

The following are existing sensitive production paths and must remain behaviorally stable:

- `POST /swap` and `POST /swap/encrypted`
- `POST /withdraw` and `POST /withdraw/encrypted`
- Require SEE middleware (`requireSeeForSensitiveFlow`) remains applied.
- Required runtime config checks (`RPC_URL`, `SHIELDED_POOL_ADDRESS`, `RELAYER_PRIVATE_KEY` except dry-run behavior) remain enforced.
- Relayer dry-run behavior and receipt structure should not regress.

Evidence:
- `phantom-relayer-dashboard/backend/src/index.js` (swap/withdraw route declarations and guards)
- `src/components/ProtocolUserDapp.jsx` (existing swap/withdraw UX paths are independent of internal route panel logic)

---

## Optional TODO Markers (Documentation Only)

- TODO: Reconcile frontend request shapes with signed typed-data backend contracts for create/cancel.
- TODO: Define SEE attestation strategy for browser client calls to internal/settlement routes.
- TODO: Verify deployed ShieldedPool ABI/source includes `internalMatchSettle` and document canonical interface location.
- TODO: Add end-to-end test covering create intent -> match hash -> settlement start/retry/status with real mounted runtime.


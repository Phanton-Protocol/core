# DApp setup (Phantom Protocol)

One place to get the full DApp running: frontend + backend on the same config.

## 1. Backend

```bash
cd backend
npm install
```

**Config:** Backend reads `backend/config.json` (or env). Ensure these match your deployed contracts:

- `RPC_URL`, `CHAIN_ID` (e.g. BSC Testnet: `97`, RPC from [deployment-config.json](../deployment-config.json))
- `SHIELDED_POOL_ADDRESS`, `NOTE_STORAGE_ADDRESS`, `SWAP_ADAPTOR_ADDRESS`, `RELAYER_STAKING_ADDRESS`
- `RELAYER_PRIVATE_KEY` (wallet that will submit relay txs)

Optional for local/solo testing:

- `DEV_BYPASS_VALIDATORS=true` — relayer runs without validator set
- `RELAYER_DRY_RUN=true` — no real txs
- `NOTES_ENCRYPTION_KEY_HEX=<64 hex chars>` or `NOTES_ENCRYPTION_KEY_FILE=/path/key.hex` — required for Module 3 encrypted note storage APIs

Start:

```bash
node src/index.js
```

Default port: **5050** (or `PORT` in config).

## 2. Frontend

```bash
cd frontend
npm install
npm run build
```

**Config:** At build time the app uses:

- `VITE_API_URL` — backend API base (e.g. the Vercel `backend` project’s **Latest Production URL** or `http://127.0.0.1:5050` for local; see `frozenProductionConfig.relayerApiBase`).
- At runtime it also loads `/config.json` (from `frontend/public/config.json`) for contract addresses.

Keep **frontend/public/config.json** in sync with your backend/chain:

- `shieldedPoolAddress`, `noteStorageAddress`, `swapAdaptorAddress`, `relayerStakingAddress`, `feeOracleAddress`, `depositHandlerAddress`, `verifierAddress`, `protocolTokenAddress`

Dev server:

```bash
VITE_API_URL=https://backend-self-nu-51.vercel.app npm run dev
```

Production: set `VITE_API_URL` in your host (e.g. Vercel/Render env) and serve the `frontend/dist` output.

## 3. Quick check

1. **Backend:** `GET /health` returns 200.
2. **Frontend:** Connect wallet (e.g. BSC Testnet 97), then: Deposit → Swap → Withdraw.
3. **Relayer:** Backend must have `RELAYER_PRIVATE_KEY` and the relayer wallet must have gas; then deposit/withdraw/swap relay txs will be submitted.

## 4. Two config sources

- **backend/config.json** — used by this repo’s backend by default.
- **deployment-config.json** — reference for a different testnet deployment (addresses may differ). If you deploy from that, copy the contract addresses into `backend/config.json` (or env) and into **frontend/public/config.json** so frontend and backend use the same chain and contracts.

Once backend and frontend point at the same RPC and contract set, the full flow (connect wallet → deposit → swap → withdraw) should work without problems.

## Module 3 note + merkle helpers

- Canonical note format + commitment/nullifier: `phantom-relayer-dashboard/backend/src/noteModel.js`
- Encrypted-at-rest note APIs: `/notes/from-deposit`, `/notes/:noteId`, `/notes`
- Merkle self-check APIs: `/merkle/index/:index`, `/merkle/self-check/:commitment`
- CLI self-check: `cd phantom-relayer-dashboard/backend && npm run merkle:selfcheck -- 0x<commitment>`

## Module 4 relayer sheltered deposit

- **Flow:** user approves `ShieldedPool` for ERC20; backend relayer wallet calls `depositFor` (no user ZK proof). See `phantom-relayer-dashboard/backend/MODULE4-RELAYER-DEPOSIT.md`.
- **Endpoints:** `POST /relayer/deposit/session`, `POST /relayer/deposit/submit`, `GET /relayer/deposit/status`
- **Env:** `RELAYER_PRIVATE_KEY` must be registered on `RelayerRegistry` (`isRelayer`); optional `MODULE4_DEPOSIT_API_SECRET` / `MODULE4_PUBLIC_SUBMIT` for submit auth; `MODULE4_MAX_BNB_WEI` for BNB cap.
- **Contracts test:** `cd Phantom-Smart-Contracts && HH_FULL=1 npx hardhat test test/depositFor.erc20.relayer.test.cjs`
- **Integration script:** `node phantom-relayer-dashboard/backend/scripts/module4-deposit-integration.cjs` (set `API_URL`, `TOKEN`, `AMOUNT`, etc.)

## Module 5 Pancake quote + relayer swap

- **Quote source priority:** Pancake V3 QuoterV2 (official testnet/mainnet addresses) → adaptor read → V2 fallback.
- **Execution path:** user signs EIP-712 intent only; relayer submits `shieldedSwapJoinSplit` (no direct user wallet swap tx to Pancake router).
- **Endpoints:** existing `/quote`, `/intent`, `/swap` (or `/swap/encrypted`) with updated intent binding.
- **Env:** `PANCAKE_V3_QUOTER_V2` (optional), `PANCAKE_V3_DEFAULT_FEE_TIER` (default `2500`), optional `PANCAKE_V2_ROUTER`, `WBNB_ADDRESS`.
- **Docs:** `phantom-relayer-dashboard/backend/MODULE5-PANCAKE-QUOTES-RELAYER-SWAP.md`.

## Module 6 shielded withdraw (relayer)

- **Flow:** user builds a withdraw-shaped join-split proof (`POST /withdraw/generate-proof`), then submits via `POST /withdraw` or `POST /withdraw/encrypted` (same SEE / validator path as other sensitive flows). The relayer calls `shieldedWithdraw` on `ShieldedPool`.
- **Fees:** the proof’s `protocolFee` must satisfy the **on-chain** minimum from `feeOracle` (see `MODULE6-WITHDRAW.md` / `CHANGELOG.md`); the backend maps common reverts to readable errors.
- **Optional recipient screening:** `CHAINALYSIS_ENABLED=true` and `CHAINALYSIS_API_URL=<HTTPS endpoint>` (POST JSON `{ "address": "<recipient>" }`). Default is off for testnet MVP.
- **Docs:** `phantom-relayer-dashboard/backend/MODULE6-WITHDRAW.md`.

## Module 7 hardening (no mocks on staging paths)

- **Operator guide:** `RUNBOOK.md` (relayer env, E2E script, `PHANTOM_DEPLOYMENT_TIER`, mock bytecode gate).
- **Contracts:** `DEPLOY_PROFILE=staging|production` never deploys MockVerifier/MockSwapAdaptor; `FORCE_MOCK_INFRASTRUCTURE=true` is rejected. On-chain smoke: `npm run assert:no-mock-pool -w phantom-smart-contracts -- --network bscTestnet` with `SHIELDED_POOL_ADDRESS` set.
- **Fingerprints:** `npm run fingerprints:mock-bytecode` from repo root after `HH_FULL=1` compile updates `config/module7-mock-bytecode-hashes.json`.

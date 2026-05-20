# Phantom Protocol — Developer Technical Specification

This document is the single technical reference for developers working on Phantom Protocol. It describes architecture, contracts, API, cryptography, configuration, and deployment in full detail. For product and business context, see WHITEPAPER.md.

**What this document gives you:** Architecture, data model (notes, commitments, nullifiers, Merkle tree), full contract list and roles, complete API endpoint list, config and env reference, deployment and networks, and where everything lives in the repo. Together with WHITEPAPER.md and the codebase, this is enough to onboard and integrate.

**What you still need from the codebase:** Exact API request/response bodies (JSON field names, types), note construction (byte layout, hash function, commitment formula), circuit public/private input order and names, contract method signatures and events (use ABIs in `Phantom-Smart-Contracts/artifacts/contracts/` after `npm run compile` from `core/`), asset id → token address mapping, EIP-712 domain and type hashes for intents, and where proof generation is invoked in the backend. For testing, run the project’s test suite and use testnet faucets for BNB; details are in the repo (e.g. DAPP-SETUP.md, backend/frontend READMEs if present). Use this spec as the map; use the code and ABIs for implementation-level detail.


## 1. Purpose and scope

Phantom Protocol is a multi-asset shielded pool and relayer network on BNB Chain. Users deposit assets, swap, withdraw, and run payroll via zero-knowledge proofs; on-chain state is commitments and nullifiers only. This spec covers:

- System architecture and data model (notes, commitments, nullifiers, Merkle tree)
- Smart contracts (names, roles, deployment)
- Backend REST API (all endpoints and usage)
- Frontend/DApp integration (config, flows)
- Relayer and staking mechanics
- FHE-based internal matching (OTC)
- Configuration (env vars, config files)
- Deployment and networks


## 2. Repository and project structure

In **`core/`**, the canonical Solidity tree and Hardhat project are **`Phantom-Smart-Contracts/`** (`contracts/`, `test/`, `scripts/deploy/`, `deployments/`, compiled output under `Phantom-Smart-Contracts/artifacts/`). See `Phantom-Smart-Contracts/DEPLOY.md` and `core/README.md`.

- **backend/** — Node.js API server: proof generation, relayer submission, quote/swap/deposit/withdraw, merkle proofs, payroll, tax keys, telemetry. Entry: `backend/src/index.js`. Port default 5050 (or `PORT`).
- **frontend/** — React/Vite DApp: wallet connect, deposit/swap/withdraw, portfolio, staking, payroll, tax reporting. Build output: `frontend/dist`. Uses `VITE_API_URL` and runtime `/config.json` for contract addresses.
- **contracts/** — In this monorepo layout: **`Phantom-Smart-Contracts/contracts/`** (Solidity: pool, handlers, adaptors, verifiers, etc.). Built with Hardhat; artifacts in **`Phantom-Smart-Contracts/artifacts/contracts/`**.
- **deployments/** — In **`Phantom-Smart-Contracts/deployments/`** (e.g. `hardhat.json`, `bscTestnet.json`) with contract addresses per network.
- **deploy/** — Deploy scripts: **`Phantom-Smart-Contracts/scripts/deploy/`**; env in **`core/.env`** (see `core/.env.example`).
- **validators/** — Optional validator nodes (validator-1, validator-2, validator-3) for multi-party relayer setups.
- **Website/** — Marketing site (separate from DApp).
- **WHITEPAPER.md** — Product and technical whitepaper (includes Reader’s guide and Table of Contents).
- **DAPP-SETUP.md** — How to run backend + frontend locally. **`Phantom-Smart-Contracts/DEPLOY-SETUP.md`** — Render/Vercel deployment options (paths under `core/`).

Config files that must stay in sync across backend, frontend, and chain:

- `backend/config.json` (or equivalent env) — RPC, chain id, contract addresses, relayer key.
- `frontend/public/config.json` — Contract addresses and chain id for the DApp.
- `deployments/*.json` — Snapshot of deployed addresses per network/deploy.


## 3. System architecture

**Components:** Shielded pool contract(s), note model, relayer network, optional validators.

**Pool assets:** BNB (native) and ERC-20 (e.g. USDT, BUSD, USDC, CAKE, WBNB on BNB Chain). Asset identity is by asset id (e.g. 0–8 on testnet).

**Note model:** A note is a private record: asset id, amount (smallest unit), commitment blinding factor, owner key material. On-chain only a **commitment** (hash of note fields) is stored; spending publishes a **nullifier** so the note cannot be spent again. The pool keeps an **incremental Merkle tree** of all commitments and a set of used nullifiers.

**Authorization:** Every state-changing operation (deposit, swap, withdraw) is authorized by a **zero-knowledge proof** (Groth16) that shows: (i) input commitment(s) are leaves of the current tree with valid Merkle path(s), (ii) nullifiers are fresh, (iii) output commitments and amounts satisfy conservation and fee rules.

**Relayers:** Submit proofs and calldata to the pool. Gas is paid from the user’s balance (note): the circuit deducts the gas amount and sends it to the relayer to pay for the transaction; relayers do not pay gas out of pocket. They do not see note contents or control funds. They may charge a relayer fee (shown in DApp). To register, the relayer stakes PHN in the relayer staking contract and runs the backend with that wallet as `RELAYER_PRIVATE_KEY`.

**Backend:** Exposes REST API for quote, intent, swap, deposit, withdraw, merkle proof, health, telemetry, staking, tax reporting keys, payroll. Runs the prover (Rapidsnark or snarkjs) to generate proofs; can act as or connect to a relayer.

**DApp:** Connects user wallet to the API and relayer; builds notes/commitments, requests quotes, signs intents (EIP-712), requests proofs, and submits via relayer.


## 4. Cryptography and data structures

**Note:** Encodes `assetId`, `amount`, commitment blinding factor, owner key material. Hash function is circuit-compatible (e.g. MiMC or Poseidon).

**Commitment:** Hash of note fields; published when the note is created and inserted as a leaf in the pool’s Merkle tree.

**Nullifier:** Derived from note and spend (e.g. hash of note + nonce or owner key); published when the note is consumed. Contract stores a set/mapping of used nullifiers to prevent double spend.

**Merkle tree:** Incremental Merkle tree of commitments. Fixed depth (e.g. 20 or 32). New commitments are appended; root is updated. Circuit takes current root as public input and proves the spent commitment is a leaf with a valid Merkle path. Backend or client fetches root and path via pool contract or backend merkle endpoint.

**Proof system:** Groth16. Join-split style circuit: input note(s) (commitment + Merkle path), public inputs (root, nullifier(s), recipient, amounts, fees), private inputs (note data, blinding factors, owner key). Outputs new note(s) (e.g. swap output + change). Enforces: balance conservation, valid nullifier derivation, valid output commitments, input in tree. Verification on-chain via Groth16Verifier or Groth16VerifierAdapter. Proof generation off-chain (backend); users do not run prover in browser.

**Intent and signature:** User signs an intent (EIP-712) with operation parameters (e.g. token in/out, amount in, min amount out, fee, deadline). Domain: chain id, shielded pool contract address, domain name/version. To avoid the security risk of any party (including the backend) seeing plaintext intents, the signed intent is protected with **Fully Homomorphic Encryption (FHE)**. The user encrypts the signed intent under an FHE public key; only ciphertext is sent to the backend or relayer. The backend or a dedicated FHE service performs verification and proof generation on the ciphertext without ever decrypting—so no party (relayer or backend operator) sees plaintext. Only (proof, calldata) are sent to the relayer for submission. If FHE is not yet deployed for the full flow, **Trusted Execution Environment (TEE)** is the fallback: intent is encrypted for the TEE’s key; only the enclave sees plaintext; the host (backend) never does. Signature binds user so parameters cannot be altered.


## 5. Core flows (technical)

**Deposit**

- User sends BNB or ERC-20 to the pool’s deposit handler.
- BNB: `depositForBNB(depositor, commitment, assetID)` with `msg.value` = deposit amount + fixed fee (e.g. $2 in BNB; $1.50 to treasury, $0.50 to relayer who submits).
- ERC-20: Approve handler then `depositFor(depositor, token, amount, commitment, assetID)`. Handler charges fixed fee ($2 equivalent; $1.50 treasury, $0.50 to relayer when relayer submits).
- Client computes note and commitment before calling; commitment is passed in and registered in the pool’s Merkle tree. Client stores note locally (or encrypted).
- **Shadow-address flow:** User requests one-time deposit address from API (`POST /shadow-address` with depositor, token, amount, commitment, assetID, deadline, signature). User sends funds to that address; sweeper/relayer calls deposit handler to register commitment.

**Swap**

- **DEX route:** User specifies input note, amount, output asset, min amount out. Backend/client gets quote from swap adaptor (`POST /quote` or adaptor `getExpectedOutput`). Circuit burns input note (or portion), mints output note and change note (incl. protocol fee). Backend generates proof; relayer submits. Adaptor executes DEX trade on-chain; pool receives output asset. Protocol fee 0.1%.
- **Internal match (OTC, Path B):** User submits an encrypted order; orders are compared by the FHE matching service without revealing amount/price (one-bit `matched` leak only in v1). On a match, the relayer updates a **pending-note ledger** off-chain (no transaction at match time). The first on-chain touch happens at **withdraw**: the user’s join-split proof spends the pre-match nullifiers, mints the post-match commitments, and enforces the 0.20 % internal-match fee in its public inputs (alongside the standard withdraw payout). Opt-in is anchored by an **on-chain encrypted enrollment** event (`enrollInternalMatch`, M6); the protocol owner can decrypt the enrollment blob for audit only — not the order book. No public order book; if no match, fallback to the DEX route. The legacy `internalMatchSettle` / `live_internal_match` flow was removed in M5; see `core/docs/internal-matching-path-b-architecture.md`.

**Withdrawal**

- User specifies note(s), recipient address, amount. Circuit proves input in tree, nullifier new, output amount minus fees to recipient. Relayer submits proof and calldata; withdraw handler transfers BNB or ERC-20 to recipient. Optional sanctions screening (Chainalysis) on recipient before submit.

**Payroll**

- Batch of withdrawals. Company deposits once, creates payroll run via API (`POST /payroll/run`), adds entries (recipient, amount, currency), then each payout is a withdrawal from pool to that recipient. API: `GET /payroll/runs`, `GET /payroll/runs/:id`, `GET /payroll/runs/:id/entries`, etc.


## 6. Smart contracts (reference)

Deployment targets: BNB Chain testnet (chain id 97), mainnet (56). Addresses live in `backend/config.json`, `frontend/public/config.json`, and `deployments/*.json`; they differ by network and deploy.

**Core**

- **ShieldedPool / ShieldedPoolUpgradeable / ShieldedPoolUpgradeableReduced** — Holds commitments, nullifiers, Merkle root; delegates to deposit/withdraw/swap handlers.
- **DepositHandler** — Accepts BNB and ERC-20 deposits, charges fee, registers commitment in pool’s tree.
- **WithdrawHandler** — Executes withdrawals given proof and calldata.
- **SwapHandler** — Executes swaps (DEX or internal).
- **PancakeSwapAdaptor** — Interfaces with PancakeSwap router for DEX path (e.g. getExpectedOutput, execute swap).
- **NoteStorage** — Optional commitment-to-note metadata (off-chain or on-chain).
- **FeeOracle / OffchainPriceOracle** — Returns protocol fee for operation/amount (e.g. $2 deposit: $1.50 to treasury, $0.50 to relayer who submits; 0.1%/0.2% swap).
- **Groth16Verifier / Groth16VerifierAdapter** — On-chain proof verification (pairing check).
- **RelayerRegistry / RelayerStaking** — PHN staking, minimum stake, reward distribution (e.g. 80% of swap fees to stakers), claim(feeToken).
- **ComplianceModule** — Optional Chainalysis/compliance integration.
- **FHECoprocessor / MatchingHandler** — Internal FHE-based order matching (OTC).
- **ShadowAddressFactory / ShadowSweeper** — Shadow-address deposit flow.
- **ProtocolToken** — PHN (protocol token).

Interfaces (in `Phantom-Smart-Contracts/contracts/.../interfaces/`): IShieldedPool, IWithdrawHandler, IFeeOracle, IPancakeSwapAdaptor, IRelayerRegistry, IVerifier, IMatchingHandler, IOffchainPriceOracle. ABIs in `Phantom-Smart-Contracts/artifacts/contracts/`.


## 7. Backend API (full endpoint list)

REST over HTTP. Base URL: e.g. Hamza Vercel backend alias `https://backend-self-nu-51.vercel.app` or `http://127.0.0.1:5050`. All endpoints are relative to base.

**Health and info**

- `GET /health` — Liveness/readiness.
- `GET /relayer` — Relayer address, dryRun, bypassValidators, chainalysisScreening.
- `GET /relayer/staking-status` — Staked balance, min stake, rewards.
- `GET /staking/stats` — totalStaked, minStake, protocolTokenAddress.
- `GET /relayer/validator-status` — bypassed, list of validators and status.
- `GET /telemetry` — anonymity set size, node count, swap count 24h, volume.

**Quote and swap**

- `POST /quote` — Body: token in, token out, amount. Returns expected output, fees.
- `POST /intent` — Create signed intent for swap (params: token in/out, amount in, min amount out, fee, deadline, etc.).
- `POST /swap` — Submit swap (intent + proof data). Returns receipt.
- `POST /swap/generate-proof` — Generate proof for swap (swap params + note data).
- `GET /portfolio/swap-fee` — Swap fee info.

**Deposit**

- `POST /deposit` — Payload: commitment, amount, asset, etc.
- `POST /shadow-address` — Request one-time deposit address (depositor, token, amount, commitment, assetID, deadline, signature).
- `POST /shadow-sweep` — Sweep shadow deposit (if used by backend).
- `GET /deposit/required-fee-bnb` — Required deposit fee in BNB.

**Withdraw**

- `POST /withdraw` — withdrawData; sanctions screening applied if enabled.

**Portfolio (note-based flows)**

- `POST /portfolio/swap`, `POST /portfolio/deposit`, `POST /portfolio/withdraw` — Portfolio-note flows.

**Merkle**

- `GET /merkle/:commitment` — Merkle path and root for commitment (backend may sync state from chain).

**Proof**

- `POST /prove` — Generic proof submission/generation.

**Tax reporting**

- `POST /tax-reporting-keys` — Create reporting key (user signs message; backend returns key once).
- `POST /tax-reporting-keys/revoke` — Revoke key.
- `GET /tax-export?key=...` — Export history (header `X-Tax-Reporting-Key` or query param). Returns only that wallet’s data for user keys.

**Payroll**

- `POST /payroll/run` — Create payroll run (company wallet, metadata).
- `GET /payroll/runs?wallet=...` — List runs.
- `GET /payroll/runs/:id` — Run detail.
- `GET /payroll/runs/:id/entries` — Entries for run. Entry endpoints for add/update/execute as per backend implementation.

**Receipt and history**

- `GET /receipt/:intentId` — Receipt for intent after tx confirmed.
- `GET /history/:address` — Transaction history for address (as allowed by backend).

**Verification key**

- `GET /verification-key` — Verification key for proofs.

**FHE (when FHE service is running)**

- `GET /fhe/public-key` — FHE public key.
- `POST /fhe/encrypt` — Encrypt payload for matching.

Backend code and Phantom SDK/docs contain full request/response shapes and integration details.


## 8. Frontend / DApp

- Connects wallet (e.g. MetaMask) and backend API. Loads contract addresses from `frontend/public/config.json` (or env at build time). Chain: BNB testnet 97 or mainnet 56.
- **Config keys (in config.json):** shieldedPoolAddress, noteStorageAddress, swapAdaptorAddress, relayerStakingAddress, feeOracleAddress, depositHandlerAddress, verifierAddress, protocolTokenAddress.
- **API base:** `VITE_API_URL` at build time or default production URL (see `src/config.js`: API_URL, DAPP_URL).
- **Flows:** Deposit (build note/commitment, call deposit handler or shadow-address flow), Swap (quote → sign intent EIP-712 → backend generates proof → relayer submits), Withdraw (recipient + amount → proof → relayer submits). Also: portfolio view, staking (stake/unstake PHN, claim rewards), payroll (create run, add entries, execute payouts), tax reporting (create/revoke key, export).


## 9. FHE and internal matching (technical)

- Internal matching (Path B) lets two parties exchange notes inside the pool without the DEX. Orders are stored encrypted (FHE) so the matcher compares predicates (e.g. `sell X for Y at price ≥ M` vs `buy X for Y at price ≤ M`) without learning the exact amount or price. The FHE matching service (TenSEAL / TFHE) returns a v2 attestation carrying only ciphertext hashes of the exec values — never plaintext. On a positive decision the backend mutates a **pending-note ledger** (encrypted at rest, hash-chained audit log) and does **not** submit any on-chain transaction. The 0.20 % internal-match fee is accrued in the ledger and enforced on-chain at withdraw inside the join-split public inputs (the user’s next chain interaction). OTC-style: no public order book; DEX fallback (0.10 %) is still available. Match-time on-chain settlement (`internalMatchSettle`, `SETTLEMENT_SUBMISSION_MODE=live_internal_match`, `createOnchainInternalMatchSubmitter`) was removed in M5; the `live_internal_match` env value is rejected by `internalMatchingGuardrails`.


## 10. Relayers and staking

- Relayers submit proofs and calldata. Gas is paid from the user’s balance (note): the circuit deducts the gas amount and sends it to the relayer to pay for the transaction; relayers do not pay gas out of pocket. They set relayer fee (e.g. 0.05% or flat BNB); DApp shows it before confirm. They do not see note data or control funds.
- **Registration:** Stake PHN in RelayerStaking (or RelayerRegistry) at or above `minStake()` (read from contract; DApp shows it). Run backend with that wallet as `RELAYER_PRIVATE_KEY`. No permission required.
- **Earnings:** (1) Relayer fee (100% to relayer). (2) $0.50 per user deposit when the relayer submits that deposit. (3) FHE matching and internal swap fees are collected and 80% is distributed monthly to stakers; proportional share claimable via staking contract; stakers claim via `claim(feeToken)` on staking contract. Slashing for misbehavior (e.g. invalid proofs) per staking contract/governance.
- **Optional validators:** `VALIDATOR_URLS` lists nodes that must attest/co-sign; threshold (e.g. 66%). `DEV_BYPASS_VALIDATORS` skips for development. `GET /relayer/validator-status` returns status.


## 11. Reporting keys and sanctions screening

**Reporting keys:** User signs message from wallet; backend verifies and issues key (stored hashed with wallet). Export: send key (header or query) to `GET /tax-export`; backend returns that wallet’s transactions only. Revoke: `POST /tax-reporting-keys/revoke`. Disclosure is per-wallet and optional; pool anonymity set unchanged.

**Sanctions screening:** If `CHAINALYSIS_API_KEY` is set, backend/relayer calls Chainalysis for depositor and withdrawal recipient addresses; rejects if sanctioned/high-risk. Default API URL overridable with `CHAINALYSIS_API_URL`. Screening does not require note contents, only on-chain address. `GET /relayer` returns `chainalysisScreening: true` when enabled.


## 12. Fees (technical reference)

- **Deposit:** Fixed $2 in BNB per deposit (deposit handler / fee oracle). Of this, $1.50 goes to the treasury and $0.50 to the relayer who submits the deposit—so a successful relayer receives $0.50 on every user deposit they process. FHE matching and internal swap fees are collected and 80% is distributed monthly to stakers, 20% to treasury. Gas is paid from the user’s balance: the circuit deducts the gas amount from the user’s deposit/operation and sends it to the relayer to pay for the transaction.
- **Swap DEX:** 0.1% of swap amount to protocol; then 80% to stakers, 20% to treasury. Relayer fee set by relayer.
- **Swap internal (OTC):** 0.2% to protocol; same 80/20 split. Relayer fee set by relayer.
- **Withdrawal:** Protocol fee and relayer fee if configured; shown in DApp before confirm. Gas is paid from the user’s note—the circuit deducts the gas amount and sends it to the relayer to pay for the transaction.
- **Gas:** Gas is always paid from the user’s balance: the circuit deducts the gas amount from the user’s note/operation and sends it to the relayer to pay for the transaction. The relayer does not pay gas out of pocket.


## 13. Deployment and networks

**Networks**

- BNB Chain testnet: chain id 97. RPC e.g. `https://data-seed-prebsc-1-s1.binance.org:8545`.
- BNB Chain mainnet: chain id 56.

**Backend environment variables (key set)**

- `RPC_URL` — Blockchain RPC endpoint.
- `CHAIN_ID` — 97 (testnet) or 56 (mainnet).
- `SHIELDED_POOL_ADDRESS` — Shielded pool contract.
- `NOTE_STORAGE_ADDRESS` — NoteStorage (if used).
- `SWAP_ADAPTOR_ADDRESS` — PancakeSwap adaptor.
- `RELAYER_STAKING_ADDRESS` — RelayerStaking (or RelayerRegistry).
- `RELAYER_PRIVATE_KEY` — Relayer wallet (must have staked PHN ≥ minStake and gas).
- `OFFCHAIN_ORACLE_ADDRESS` — Fee oracle.
- `ORACLE_SIGNER_PRIVATE_KEY` — If oracle requires signing.
- `CHAINALYSIS_API_KEY` — Optional; enables sanctions screening.
- `CHAINALYSIS_API_URL` — Optional override for Chainalysis API.
- `VALIDATOR_URLS` — Optional; comma-separated validator endpoints.
- `DEV_BYPASS_VALIDATORS` — If true (or VALIDATOR_URLS empty), no validator coordination.
- `RELAYER_DRY_RUN` — If true, no real txs submitted.
- `PORT` — Server port (default 5050).

**Deployment address examples (from repo)**

- `deployments/complete-system.json`: shieldedPoolAddress, matchingHandlerAddress, fheCoprocessorAddress, network, chainId.
- `deploy/.env`: SHIELDED_POOL_ADDRESS, NOTE_STORAGE_ADDRESS, SWAP_ADAPTOR_ADDRESS (and relayer config in validators).

**Production**

- DApp/API: production alias `https://backend-self-nu-51.vercel.app`. Marketing site is separate. Frontend default API URL in `src/config.js` (`frozenProductionConfig.relayerApiBase`, `VITE_API_URL`).

**Testnet tokens (example)**

- WBNB, tBUSD, tUSDT, tUSDC, tCAKE, tBTCB, tETH, tDAI (asset ids 0–8). Pool and adaptor support multiple assets via asset id mapping.


## 14. Configuration reference

**backend/config.json (or env)**

- Must include: RPC_URL, CHAIN_ID, SHIELDED_POOL_ADDRESS, NOTE_STORAGE_ADDRESS, SWAP_ADAPTOR_ADDRESS, RELAYER_STAKING_ADDRESS, RELAYER_PRIVATE_KEY.
- Optional: OFFCHAIN_ORACLE_ADDRESS, ORACLE_SIGNER_PRIVATE_KEY, CHAINALYSIS_API_KEY, CHAINALYSIS_API_URL, VALIDATOR_URLS, DEV_BYPASS_VALIDATORS, RELAYER_DRY_RUN, PORT.

**frontend/public/config.json**

- Must match backend/chain: shieldedPoolAddress, noteStorageAddress, swapAdaptorAddress, relayerStakingAddress, feeOracleAddress, depositHandlerAddress, verifierAddress, protocolTokenAddress (and chainId if used).

**frontend build**

- `VITE_API_URL` — Backend API base (e.g. `http://localhost:5050` or production URL).


## 15. Running locally and deploying

**Backend:** `cd backend && npm install && node src/index.js` (see DAPP-SETUP.md). Ensure config.json or env matches deployed contracts and RPC.

**Frontend:** `cd core && npm install && VITE_API_URL=https://backend-self-nu-51.vercel.app npm run dev` (or `npm run build` for production). Keep `public/config.json` in sync with backend/chain.

**Deploy:** See `Phantom-Smart-Contracts/DEPLOY-SETUP.md` for Render (full app or static site) and Vercel (frontend only; backend elsewhere). Render one-service option: build command installs backend + frontend deps and builds frontend; start command `node backend/src/index.js`.


## 16. References

- **WHITEPAPER.md** — Full technical whitepaper (architecture, cryptography, flows, fees, use cases, glossary). Use Table of Contents and Reader’s guide for navigation.
- **DAPP-SETUP.md** — Backend + frontend local setup and config sync.
- **`Phantom-Smart-Contracts/DEPLOY-SETUP.md`** — Render and Vercel deployment options.
- **deployments/complete-system.json** — Example deployment addresses (testnet).
- **deploy/.env**, **validators/*/\.env** — Example env for deployer and validators.
- **Phantom-Smart-Contracts/artifacts/contracts/** — Compiled contract ABIs and artifacts (Hardhat).
- **Phantom-Smart-Contracts/contracts/interfaces/** — Solidity interfaces for integration.

For integration, use the same RPC and contract set across backend, frontend, and any scripts; then deposit → swap → withdraw and relayer/staking flows should work end-to-end.

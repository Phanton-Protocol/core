# Phantom — Hardhat deployment

## Architecture (this repo)

- **Primary deployable (non-upgradeable path):** `ShieldedPool` — holds commitments, nullifiers, Merkle state; constructor takes verifiers, swap adaptor, `FeeOracle`, `RelayerRegistry`. See `DEVELOPER_SPEC.md` §6.
- **Upgradeable variant:** `ShieldedPoolUpgradeable` (UUPS) + governance/timelock is a separate track; scripts here target the **direct `ShieldedPool`** flow first.
- **Libraries** (`MerkleTree`, `IncrementalMerkleTree`, …) are compiled into `ShieldedPool`; no separate library deployment.

## Prerequisites

1. Copy **`core/.env.example`** → **`core/.env`** and set `DEPLOYER_PRIVATE_KEY` or `PRIVATE_KEY`.
2. Compile the **full** contract tree (deploy scripts use `contracts/_full`):

   ```bash
   cd core/Phantom-Smart-Contracts
   HH_FULL=1 npm run compile
   ```

   Or from **`core/`**: `HH_FULL=1 npm run compile:full`

## Join-split Groth16 (Module 2)

- Public signal order / `Fr` reduction: **`circuits/CIRCUITS.md`**
- Pinned wasm / zkey / vk hashes: **`circuits/joinsplit_public9/manifest.json`**
- Regenerate verifier + zkey (after Circom edits): `npm run circuit:build:joinsplit` then update manifest hashes and run `HH_FULL=1 npm test`.

## Deploy profiles (Module 1)

| `DEPLOY_PROFILE` | Verifiers | Swap adaptor |
|------------------|-----------|----------------|
| **`dev`** (default) | `MockVerifier` ×2 | `MockSwapAdaptor` |
| **`staging`** / **`production`** | `Groth16Verifier` + `Groth16VerifierAdapter` (same adapter wired to join/portfolio/threshold slots) | `PancakeSwapAdaptor(router, wbnb)` — **real** Pancake V2-style router + WBNB |

**Staging / production** also requires in **`core/.env`** (loaded by Hardhat):

| Variable | Description |
|----------|-------------|
| `PANCAKE_ROUTER` | PancakeSwap **V2** router address for the target network (testnet/mainnet). |
| `WBNB_ADDRESS` | Wrapped native token for that chain. |
| `JOIN_SPLIT_GROTH16_ADDRESS` | *(Optional)* Use an **already deployed** `Groth16Verifier` instead of deploying a new one from `JoinSplitVerifier.sol`. |

Example — **BSC testnet** with real infra (no mocks):

```bash
cd core/Phantom-Smart-Contracts
export DEPLOY_PROFILE=staging
export PANCAKE_ROUTER=0x...   # BSC testnet Pancake V2 router
export WBNB_ADDRESS=0x...     # WBNB on testnet
HH_FULL=1 npx hardhat run scripts/deploy/deploy-core.ts --network bscTestnet
```

`dev` profile (omit or `DEPLOY_PROFILE=dev`): no router env vars needed.

### FeeOracle (BSC testnet / MVP)

`FeeOracle` can read **Chainlink** aggregators via `latestRoundData` when `priceFeeds[token]` points to a live feed. After deploy, run **`scripts/deploy/seed-assets.ts`** with optional env:

- `BNB_USD_FEED` — set native token feed (`setPriceFeed(0x0, feed)`).
- `ASSET_1_ADDRESS`, `ASSET_1_USD_FEED`, `ASSET_2_ADDRESS`, `ASSET_2_USD_FEED` — register MVP assets and feeds.

**MVP note:** Until mainnet-grade feeds are configured everywhere, fee math may fall back to `getUSDValue == 0` paths for unset feeds. **Mainnet parity** for oracle economics is tracked separately from Module 1.

```bash
HH_FULL=1 npx hardhat run scripts/deploy/seed-assets.ts --network bscTestnet
```

## Governance (`contracts/_full/core/Governance.sol`)

Token-weighted proposals with a **two-step execution delay**: after voting ends and the proposal passes, call **`queue(proposalId)`**, wait **`EXECUTION_DELAY` (2 days)** from `queuedAt[proposalId]`, then call **`execute(proposalId)`**. Do **not** skip straight from “voting passed” to `execute` — `execute` requires `queue` first.

| Variable | Default | Description |
|----------|---------|-------------|
| `PROTOCOL_TOKEN_ADDRESS` | *(required for `deployGovernance.ts`)* | Token implementing `IProtocolToken` (votes + proposal threshold). |
| `GOVERNANCE_OWNER` | deployer | On-chain `owner` field. |
| `GOVERNANCE_VOTING_PERIOD_BLOCKS` | `50400` | Voting window in blocks (~7d @ ~12s/block). |
| `GOVERNANCE_QUORUM` | `1000000000000000000` | Minimum combined for+against voting weight for `queue`. |
| `GOVERNANCE_MIN_PROPOSAL_THRESHOLD` | `100000000000000000000000` | **100k tokens** (18 decimals) minimum `balanceOf` to `propose`. |

**Production:** after `queue`, wait the full **2-day** on-chain delay before `execute`. **Local tests:** advance time with Hardhat helpers between `queue` and `execute`.

Standalone deploy (token already deployed):

```bash
cd core/Phantom-Smart-Contracts
export PROTOCOL_TOKEN_ADDRESS=0x...
HH_FULL=1 npx hardhat run scripts/deploy/deployGovernance.ts --network bscTestnet
```

`deploy-pathb-reduced.ts` also deploys this Governance next to a fresh `ProtocolToken`.

## Scripts (incremental)

| Phase | Script | Purpose |
|-------|--------|---------|
| 1 | `scripts/deploy/deploy-core.ts` | Infra profile + `FeeOracle` + `RelayerRegistry` + **`ShieldedPool`** |
| 2 | `scripts/deploy/deploy-handlers.ts` | `DepositHandler` + `TransactionHistory`, then `setDepositHandler` / `setTransactionHistory` on the pool |
| All-in-one | `scripts/deploy/deploy-all.ts` | Same as 1+2 in **one** `hardhat run` (use for **`--network hardhat`**; see below) |
| Optional | `scripts/deploy/deployGovernance.ts` | Deploy **`Governance`** (core) against an existing `PROTOCOL_TOKEN_ADDRESS` |
| Optional | `scripts/deploy/seed-assets.ts` | Register `assetId` ↔ tokens + Chainlink feeds (see env vars above) |

Outputs are merged into **`deployments/<networkName>.json`** (e.g. `deployments/bscTestnet.json`).

**Important:** The in-memory **`hardhat`** chain resets on every `hardhat run`. Running `deploy-core.ts` and then `deploy-handlers.ts` as **two separate commands** on `hardhat` will point handlers at the wrong addresses. For local smoke tests use **`deploy-all.ts`**, or use a persistent network (`bscTestnet` / `bsc`) where two-step deploy is correct.

## Commands

**BSC Testnet (chain id 97):**

```bash
npx hardhat run scripts/deploy/deploy-core.ts --network bscTestnet
npx hardhat run scripts/deploy/deploy-handlers.ts --network bscTestnet
```

**BSC mainnet (56):**

```bash
npx hardhat run scripts/deploy/deploy-core.ts --network bsc
npx hardhat run scripts/deploy/deploy-handlers.ts --network bsc
```

**Local Hardhat (smoke test — single process):**

```bash
npx hardhat run scripts/deploy/deploy-all.ts --network hardhat
```

RPC defaults come from `config/bscTestnet.json` and `config/bscMainnet.json`; override with `BSC_TESTNET_RPC` / `BSC_MAINNET_RPC` in `.env`.

## Notes

- **`MockVerifier`** is only for **`DEPLOY_PROFILE=dev`** — not for production.
- **`SwapHandler` / `WithdrawHandler`** are used by **`ShieldedPoolUpgradeable`**, not by the base `ShieldedPool` in this tree; add a separate script when you deploy the upgradeable stack.

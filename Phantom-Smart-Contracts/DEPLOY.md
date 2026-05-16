# Phantom — Hardhat deployment

## Architecture (Path-B production)

| Role | Artifact | Deploy |
|------|----------|--------|
| **Production pool (canonical)** | `ShieldedPoolUpgradeableReduced` (UUPS) | `deploy-pathb-reduced.ts` |
| **Relayer registry (production)** | `RelayerStaking` → wired as `pool.relayerRegistry` | same script |
| **Lab / legacy** | `ShieldedPool` (non-upgradeable) | `deploy-core.ts`, `deploy-all.ts` |
| **Alternate upgradeable** | `ShieldedPoolUpgradeable` (full handlers; oversized) | manual / research only |
| **Experimental** | FHE, dark pool, internal matching, … | blocked on staging/production — see `contracts/_full/experimental/README.md` |

**Operator runbook:** [docs/PATH_B_PRODUCTION_RUNBOOK.md](./docs/PATH_B_PRODUCTION_RUNBOOK.md) (governance migration, emergency pause, relayer SOT, privacy roadmap).

## Prerequisites

1. Copy **`core/.env.example`** → **`core/.env`** and set `DEPLOYER_PRIVATE_KEY` or `PRIVATE_KEY`.
2. Compile the **full** contract tree:

   ```bash
   cd core/Phantom-Smart-Contracts
   HH_FULL=1 npm run compile
   ```

## Path-B production deploy (recommended)

```bash
cd core/Phantom-Smart-Contracts
export DEPLOY_PROFILE=staging          # or production
export EXPECTED_CHAIN_ID=97            # 97 = BSC testnet, 56 = mainnet
export WALLET_A_ADDRESS=0x...
export WALLET_B_ADDRESS=0x...
export WALLET_B_PRIVATE_KEY=0x...

HH_FULL=1 npx hardhat run scripts/deploy/deploy-pathb-reduced.ts --network bscTestnet
```

Or: `npm run deploy:testnet:reduced` (sets `HH_FULL=1`).

**Fail-fast gates** (`scripts/deploy/networkConfig.ts`): `EXPECTED_CHAIN_ID`, canonical BSC feeds/router/WBNB, `assertOffchainOraclePolicy` (no offchain oracle on mainnet), `assertExperimentalDeployBlocked()`.

Post-deploy: `configure-reduced-stack.ts`, then governance migration per runbook §3.

## Deploy profiles

| `DEPLOY_PROFILE` | Verifiers | Swap adaptor |
|------------------|-----------|----------------|
| **`dev`** (default) | `MockVerifier` ×2 | `MockSwapAdaptor` |
| **`staging`** / **`production`** | `Groth16Verifier` + adapters | `PancakeSwapAdaptor(router, wbnb)` |

**Staging / production** require:

| Variable | Description |
|----------|-------------|
| `EXPECTED_CHAIN_ID` | Must match RPC (`97` / `56`) |
| `PANCAKE_ROUTER` | Optional override; validated against canonical book |
| `WBNB_ADDRESS` | Optional override; validated against canonical book |
| `BNB_USD_FEED` | Optional override; validated against canonical book |
| `JOIN_SPLIT_GROTH16_ADDRESS` | Optional existing verifier |

`OFFCHAIN_ORACLE_ADDRESS` is **forbidden** on BSC mainnet (chainId 56).

## Join-split Groth16 (Module 2)

- Public signals: **`circuits/CIRCUITS.md`**
- Pins: **`circuits/joinsplit_public9/manifest.json`**
- Rebuild: `npm run circuit:build:joinsplit` then `npm test`

## Governance

Token-weighted proposals: **`queue(proposalId)`** → wait **`EXECUTION_DELAY` (2 days)** → **`execute(proposalId)`**.

Secure timelock deploy: `scripts/deploy/deploy-secure-governance.ts`  
Migration checklist + asserts: [docs/PATH_B_PRODUCTION_RUNBOOK.md](./docs/PATH_B_PRODUCTION_RUNBOOK.md) §3.

| Variable | Description |
|----------|-------------|
| `PROTOCOL_TOKEN_ADDRESS` | For standalone `deployGovernance.ts` |
| `GOVERNANCE_TIMELOCK_ADDRESS` | Required for `configure-reduced-stack` timelock wiring |

## Scripts

| Script | Purpose |
|--------|---------|
| **`deploy-pathb-reduced.ts`** | **Path-B production** — Reduced pool + RelayerStaking + SHDW |
| `deploy-core.ts` | Legacy `ShieldedPool` + `RelayerRegistry` (lab) |
| `deploy-handlers.ts` | Handlers for legacy pool |
| `deploy-all.ts` | Local one-shot legacy stack (`--network hardhat`) |
| `configure-reduced-stack.ts` | Handlers, feeds, timelocks on deployed reduced pool |
| `deploy-secure-governance.ts` | Timelock + hardened Governance |
| `assert-governance-migration.ts` | Post-migration verification |
| `assert-pathb-relayer.ts` | RelayerStaking wiring check |
| `seed-assets.ts` | Register assets + Chainlink feeds |

Outputs: **`deployments/<network>.json`** and `deployments/pathb-reduced-*.json`.

**Note:** Two separate `hardhat run` commands on **`--network hardhat`** reset state — use **`deploy-all.ts`** locally or a persistent RPC for multi-step deploys.

## Commands

**BSC testnet (97):**

```bash
HH_FULL=1 npx hardhat run scripts/deploy/deploy-pathb-reduced.ts --network bscTestnet
```

**BSC mainnet (56):**

```bash
export DEPLOY_PROFILE=production
export EXPECTED_CHAIN_ID=56
HH_FULL=1 npx hardhat run scripts/deploy/deploy-pathb-reduced.ts --network bsc
```

**Local Hardhat (legacy smoke):**

```bash
HH_FULL=1 npx hardhat run scripts/deploy/deploy-all.ts --network hardhat
```

RPC: `config/bscTestnet.json`, `config/bscMainnet.json`; override with `BSC_TESTNET_RPC` / `BSC_MAINNET_RPC`.

## Notes

- **`MockVerifier`** — `DEPLOY_PROFILE=dev` only.
- Path-B reduced pool runs join-split **inline**; `SwapHandler` is deployed by `configure-reduced-stack` but **not** wired on the reduced pool.
- Bytecode CI gate: `node scripts/checkBytecodeSize.cjs` (runs in `npm test`).

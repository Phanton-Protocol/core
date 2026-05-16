# Phantom Smart Contracts

Hardhat project for the Phantom protocol: **`contracts/`**, **`test/`**, **`scripts/deploy/`**, **`deployments/`**, and **`config/`** (network defaults).

Run all commands **from this directory** (`core/Phantom-Smart-Contracts`) or via **`npm run <script> -w phantom-smart-contracts`** from **`core/`**.

## Path-B production artifact (canonical)

| Item | Value |
|------|--------|
| **Contract** | `ShieldedPoolUpgradeableReduced` (UUPS) |
| **Deploy script** | `scripts/deploy/deploy-pathb-reduced.ts` → `npm run deploy:testnet:reduced` |
| **Relayer registry** | `RelayerStaking` at `pool.relayerRegistry()` (implements `IRelayerRegistry`) |
| **Ops runbook** | [docs/PATH_B_PRODUCTION_RUNBOOK.md](./docs/PATH_B_PRODUCTION_RUNBOOK.md) |

**Not** default for BSC staging/mainnet: `ShieldedPool`, `ShieldedPoolUpgradeable`, and contracts under `contracts/_full/experimental/` (see [experimental README](./contracts/_full/experimental/README.md)).

## Commands

| Command | Description |
|--------|----------------|
| `npm run compile` | `contracts/stage1` (default) |
| `npm run compile:full` | `contracts/_full` (`HH_FULL=1`, Solidity 0.8.28 + `viaIR`) |
| `npm test` | Full-tree tests + EIP-170 gate on `ShieldedPoolUpgradeableReduced` |
| `npm run deploy:testnet:reduced` | **Path-B production** deploy (reduced pool + RelayerStaking) |
| `npm run deploy:all:local` | Local legacy `ShieldedPool` smoke deploy (lab only) |
| `npm run circuit:build:joinsplit` | Rebuild `joinsplit_public9` → verifier artifacts |

See **[DEPLOY.md](./DEPLOY.md)** for networks, **`DEPLOY_PROFILE`**, governance migration, and **`seed-assets.ts`**.  
Join-split Groth16: **[circuits/CIRCUITS.md](./circuits/CIRCUITS.md)**.  
Environment: **`../.env`** or local **`.env`** (see **`../.env.example`**).

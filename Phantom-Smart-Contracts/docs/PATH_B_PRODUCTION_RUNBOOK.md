# Path-B production runbook

**Canonical on-chain artifact:** `ShieldedPoolUpgradeableReduced` (UUPS).  
**Canonical deploy script:** `scripts/deploy/deploy-pathb-reduced.ts` (`npm run deploy:testnet:reduced`).

Alternate / lab-only (do **not** use for BSC staging or mainnet liquidity):

| Artifact | Script | Notes |
|----------|--------|--------|
| `ShieldedPool` | `deploy-core.ts`, `deploy-all.ts` | Non-upgradeable; internal-match / legacy tests |
| `ShieldedPoolUpgradeable` | manual / research | Full handler stack; EIP-170 risk; see `contracts/_full/experimental/README.md` |
| Experimental pools | blocked by `assertExperimentalDeployBlocked()` | FHE, dark pool, internal matching, etc. |

---

## 1. Production deploy (summary)

```bash
cd core/Phantom-Smart-Contracts
HH_FULL=1 npm run compile

# Staging / production: bind RPC + chain
export DEPLOY_PROFILE=staging          # or production
export EXPECTED_CHAIN_ID=97            # 97 testnet, 56 mainnet
export HARDHAT_NETWORK=bscTestnet      # or bsc

HH_FULL=1 npx hardhat run scripts/deploy/deploy-pathb-reduced.ts --network bscTestnet
```

Deploy gates live in `scripts/deploy/networkConfig.ts` (chainId, canonical BSC feeds/router/WBNB, offchain oracle forbidden on mainnet, experimental pool flags).

Post-deploy wiring: `scripts/deploy/configure-reduced-stack.ts` (handlers, timelocks when `GOVERNANCE_TIMELOCK_ADDRESS` is set).

---

## 2. Relayer source of truth (Path-B)

| Layer | Contract | Role |
|-------|----------|------|
| **Production** | `RelayerStaking` | Stake-gated `IRelayerRegistry`; fee distribution; wired in `pool.initialize(..., relayerStaking)` |
| **Tests / legacy** | `RelayerRegistry` | Owner-registered relayers; no staking — **not** production Path-B |

The pool storage field is named `relayerRegistry` (`IRelayerRegistry`) but Path-B **must** point it at a deployed `RelayerStaking` address.  
`deploy-pathb-reduced.ts` deploys `RelayerStaking` and calls `setFeeDistributor(pool, true)`.

Verify after deploy:

```bash
HH_FULL=1 npx hardhat run scripts/deploy/assert-pathb-relayer.ts --network bscTestnet
# Env: REDUCED_POOL_ADDRESS, REDUCED_RELAYER_REGISTRY_ADDRESS (RelayerStaking)
```

---

## 3. Governance migration checklist

Run after `deploy-secure-governance.ts` (or reuse an existing timelock). See also `core/docs/SECURITY_FIXES_MODULE1.md` §4.

### 3.1 Deploy timelock + governance (if new)

```bash
cd core/Phantom-Smart-Contracts
HH_FULL=1 GUARDIAN_MULTISIG=0xYourMultisig \
  TIMELOCK_DELAY_SECONDS=172800 \
  npx hardhat run scripts/deploy/deploy-secure-governance.ts --network bscTestnet
```

Record: `TIMELOCK`, `GOVERNANCE`, `PROTOCOL_TOKEN`.

### 3.2 Pool proxy — `initializeV2`

From the **current pool owner** (once per proxy, `reinitializer(2)`):

```javascript
// hardhat console — replace addresses
const pool = await ethers.getContractAt("ShieldedPoolUpgradeableReduced", POOL);
await pool.initializeV2(TIMELOCK, EMERGENCY_ADMIN);
await pool.transferOwnership(TIMELOCK);
```

### 3.3 FeeOracle — `initializeTimelock`

```javascript
const fo = await ethers.getContractAt("FeeOracle", FEE_ORACLE);
await fo.initializeTimelock(TIMELOCK);
// optional: await fo.transferOwnership(TIMELOCK);
```

### 3.4 ComplianceModule — `initializeTimelock` (if deployed)

```javascript
const cm = await ethers.getContractAt("ComplianceModule", COMPLIANCE);
await cm.initializeTimelock(TIMELOCK);
```

### 3.5 Renounce stray timelock roles

On `TimelockController`, confirm deployer no longer holds:

- `PROPOSER_ROLE` (only `Governance` should propose)
- `TIMELOCK_ADMIN_ROLE` (deployer should have renounced in `deploy-secure-governance.ts`)

```javascript
const tlc = await ethers.getContractAt("TimelockController", TIMELOCK);
const PROPOSER = await tlc.PROPOSER_ROLE();
const ADMIN = await tlc.TIMELOCK_ADMIN_ROLE();
await tlc.hasRole(PROPOSER, DEPLOYER);  // must be false
await tlc.hasRole(ADMIN, DEPLOYER);     // must be false
```

### 3.6 Automated migration assert

```bash
export GOVERNANCE_TIMELOCK_ADDRESS=0x...
export REDUCED_POOL_ADDRESS=0x...
export REDUCED_FEE_ORACLE_ADDRESS=0x...
export REDUCED_RELAYER_REGISTRY_ADDRESS=0x...   # RelayerStaking
export COMPLIANCE_MODULE_ADDRESS=0x...            # optional
export EMERGENCY_ADMIN_ADDRESS=0x...              # optional (else checks nonzero)

HH_FULL=1 npx hardhat run scripts/deploy/assert-governance-migration.ts --network bscTestnet
```

---

## 4. Emergency response

| Action | Caller | Effect |
|--------|--------|--------|
| `pauseEmergency()` | `emergencyAdmin` | Blocks deposit, withdraw, join-split, **`commitSwap`**, sweeps |
| `unpauseEmergency()` | `owner()` (timelock after migration) | Restores user flows |
| `setRelayerBlacklisted(relayer, true)` | `owner()` | Blocks relayer-submitted spends |
| UUPS upgrade | `timelock` (post-`initializeV2`) | Governance vote → schedule on timelock |

**MEV / swap:** `commitSwap` reverts with `EmergencyPausedErr` while paused (M-13).  
**Upgrades:** schedule `upgradeToAndCall` on the proxy through the timelock after a passed governance proposal.

---

## 5. Compliance batch (M-12)

`ComplianceModule.batchCheckAddresses` uses internal `_checkAddress` (no `this.checkAddress` self-auth).  
`MAX_BATCH_CHECK_SIZE = 50`. Callers must hold `onlyAuthorizedMutator` (authorized pool).

---

## 6. Privacy roadmap

| Version | Join-split public inputs | Status |
|---------|--------------------------|--------|
| **v1 (Path-B today)** | Amounts, asset IDs, Merkle path in proof / public vector | Deployed (`joinsplit_public9`, reduced pool) |
| **v2 (roadmap)** | Hidden amounts / private asset metadata in-circuit | Not in scope for current bytecode; requires new circuits + verifier rollout |

No semantic change to v1 economics without a new governance upgrade and circuit audit.

---

## 7. Testing and coverage

| Command | Purpose |
|---------|---------|
| `npm test` | Full suite + EIP-170 gate on `ShieldedPoolUpgradeableReduced` |
| `npm run test:coverage:notes` | Print solidity-coverage workflow (optional devDep) |
| `HH_FULL=1 npx hardhat test test/security/module7.coverageOrdered.test.cjs` | Pause, batch compliance, deploy guards, lightweight invariants |

**Solidity coverage (optional):** install `solidity-coverage` + `hardhat coverage` locally; not required for CI merge if `npm test` passes.

**Invariants (lightweight, in module7):** `RelayerStaking.totalStaked` ≤ token balance; nullifier set after withdraw.

**BSC mainnet fork — `OffchainForbiddenOnMainnet`:** Hardhat config has no pinned mainnet fork yet. Policy is enforced at deploy via `assertOffchainOraclePolicy(56, …)` and unit-tested locally. Next step: add `hardhat.networks.hardhat.forking` + dedicated fork test when `BSC_MAINNET_RPC` is available in CI.

---

## 8. Related docs

- `DEPLOY.md` — commands and env tables  
- `contracts/_full/experimental/README.md` — blocked research contracts  
- `core/docs/SECURITY_FIXES_MODULE1.md` — Module 1 migration detail  
- `circuits/CIRCUITS.md` — join-split public signal layout (v1)

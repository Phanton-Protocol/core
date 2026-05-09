# Phase 7 — BSC Testnet Deployment

This document records the **first deployment of the Phase 1+ ShieldedPool**
(with `internalMatchSettle` + signed-intent verification) to BSC testnet
(chainId `97`).

## Owner / Deployer

| Field | Value |
| --- | --- |
| Address | `0x8F41eA1304032b69b03ED01708ac8522627c2734` |
| Network | BSC testnet (chainId 97) |
| RPC | `https://data-seed-prebsc-1-s1.binance.org:8545` |
| Deploy profile | `dev` (mock verifiers + mock swap adaptor) |
| Deployed at | 2026-05-09T17:33:11Z |

## Deployed contracts

| Contract | Address | Bytecode |
| --- | --- | --- |
| `ShieldedPool` | `0xE18051F9fabb4ABB12e18BE4931A15f2Ef9a4631` | 24 564 bytes |
| `InternalMatchIntentLib` (linked) | `0x5Fd208f66F8A7C1200f9284569370366Ca632E7E` | 6 591 bytes |
| `FeeOracle` | `0x0c2F90A2CEe393260B7E7DB865f5424a93fD12C9` | 3 352 bytes |
| `RelayerRegistry` (`relayerStaking` alias) | `0xB7ba5565C59289ee74fF2a0d31bbe4F78a7d01e2` | 1 097 bytes |
| `MockSwapAdaptor` | `0x7ecf116f881cb2F8ABd31DFF2704E6a2f7D3169E` | 159 bytes |
| `MockVerifier` (joinSplit / portfolio) | `0x7B58230D3869C7f7266B82B420828Cf566e1BFb6` | 169 bytes |
| `MockVerifier` (threshold) | `0x5100BD6B0904ab0514fFadf100C979266814a13d` | 169 bytes |

The new addresses replace the previous `shieldedPool` entry in
[`Phantom-Smart-Contracts/config/bscTestnet.json`](../Phantom-Smart-Contracts/config/bscTestnet.json),
and are also captured in
[`Phantom-Smart-Contracts/deployments/bscTestnet.json`](../Phantom-Smart-Contracts/deployments/bscTestnet.json).

## Why a linked library?

Phase 1 added EIP-712 verification for `SignedInternalMatchIntent`
(maker + taker), additional EIP-712 typehashes/domain constants, two new
mappings (`internalMatchAttestationNonceUsed`, `internalMatchIntentNonceUsed`,
`usedInternalMatchHashes`, `usedInternalDecisionHashes`) and the
`internalMatchSettle` orchestration. This pushed `ShieldedPool` ~5 KB above
EIP-170 (24 576 bytes) on the optimizer settings used for BSC testnet.

To stay deployable without forking the protocol topology (proxy split, etc.),
the heavy crypto (digest computation, ECDSA recovery, attestation +
proof-context binding, settlement orchestration, relayer-attestation
verification) was moved into a **linked external library**
[`InternalMatchIntentLib`](../Phantom-Smart-Contracts/contracts/_full/libraries/InternalMatchIntentLib.sol).
ShieldedPool delegate-calls into the library at runtime, so:

- `address(this)` and `block.chainid` inside the library still resolve to the
  ShieldedPool, keeping EIP-712 domain separators identical to the inlined
  version (no signature compatibility break).
- All storage writes (used hashes, used nonces) hit ShieldedPool's storage via
  the storage references passed by reference.
- Custom errors keep the same `PoolErr(uint8)` 4-byte selector, so test
  matchers and client clients see identical revert payloads.

The reduction is documented in commit notes; the resulting deployed bytecode
is **24 564 bytes** (12 bytes of EIP-170 headroom).

## Replicating the deploy

```bash
cd core/Phantom-Smart-Contracts

DEPLOYER_PRIVATE_KEY=<owner-private-key> \
DEPLOY_PROFILE=dev \
HH_FULL=1 \
npx hardhat run scripts/deploy/deploy-core.ts --network bscTestnet
```

`DEPLOY_PROFILE=dev` keeps mock verifiers + mock swap adaptor (matches the
prior testnet topology). For real verifiers + PancakeSwap routing use
`DEPLOY_PROFILE=staging` and the additional env vars listed in
[`scripts/deploy/deployInfrastructure.ts`](../Phantom-Smart-Contracts/scripts/deploy/deployInfrastructure.ts).

## Smoke verification

After the deploy the following should hold (and were checked):

- `getCommitmentCount()` returns `0`.
- `MAX_TREE_DEPTH()` returns `10`.
- `getMerkleRoot()` returns the empty-tree root (deterministic for a fresh
  IncrementalMerkleTree).
- `getCode(shieldedPool)` length matches the local artifact (`24 564` bytes).

## Backend wiring

Backend consumers reading `Phantom-Smart-Contracts/config/bscTestnet.json`
(e.g. `core/phantom-relayer-dashboard/backend/src/runtimeConfig.js`) will pick
up the new `shieldedPool` address automatically. To switch a running backend
without a redeploy, set the env override:

```bash
SHIELDED_POOL_ADDRESS=0xE18051F9fabb4ABB12e18BE4931A15f2Ef9a4631
PHANTOM_CHAIN_ID=97
RPC_URL=https://data-seed-prebsc-1-s1.binance.org:8545
```

The relayer key used to send `internalMatchSettle` transactions must already
be registered through `RelayerRegistry.registerRelayer(relayer)`; the deploy
script auto-registers the deployer (`0x8F41…2734`) so it can call
`internalMatchSettle` immediately. Additional relayers can be registered with:

```bash
cast send 0xB7ba5565C59289ee74fF2a0d31bbe4F78a7d01e2 \
  "registerRelayer(address)" <relayer> \
  --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545 \
  --private-key <owner-key>
```

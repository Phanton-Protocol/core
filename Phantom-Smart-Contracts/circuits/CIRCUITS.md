# Join-split Groth16 (Module 2)

## On-chain public input vector (canonical)

`ShieldedPool._joinSplitPublicInputsToArray` passes **exactly ten** `uint256` values to `IVerifier.verifyProof` (via `Groth16VerifierAdapter`). These must match the Groth16 circuit’s public outputs **in order**.

| Index | Solidity source field | Type | Notes |
|------:|------------------------|------|--------|
| 0 | `inputs.nullifier` | `bytes32` → `uint256` | |
| 1 | `inputs.inputCommitment` | `bytes32` → `uint256` | |
| 2 | `inputs.outputCommitmentSwap` | `bytes32` → `uint256` | |
| 3 | `inputs.outputCommitmentChange` | `bytes32` → `uint256` | |
| 4 | `inputs.merkleRoot` | `bytes32` → `uint256` | |
| 5 | `inputs.outputAmountSwap` | `uint256` | |
| 6 | `inputs.minOutputAmountSwap` | `uint256` | |
| 7 | `inputs.protocolFee` | `uint256` | |
| 8 | `inputs.gasRefund` | `uint256` | |
| 9 | `_computeJoinSplitRoutingCommitment(inputs)` | `uint256` | MiMC7 commitment over routing amount/asset metadata |

**Field reduction:** `ShieldedPool._joinSplitPublicInputsToArray` (and handler helpers) pass each value as `uint256(...) % SNARK_SCALAR_FIELD` so calldata matches Circom’s `Fr` semantics (same reduction snarkjs uses in public signals). Merkle / nullifier logic still uses the full `bytes32` keys from `JoinSplitPublicInputs`.

`JoinSplitPublicInputs` also carries **calldata-only** fields (asset IDs, `swapAmount`, Merkle siblings, etc.). The Groth16 verifier receives the ten public field elements above; the new `routingCommitment` output binds those private routing fields in-circuit.

**Note:** `ShieldedPoolUpgradeable` uses a **29-element** public vector for join-split (includes Merkle path indices in-circuit). That path is not covered by `joinsplit_public9`; only the **non-upgradeable `ShieldedPool`** 10-signal layout matches this artifact.

## Circom: `joinsplit_public9`

- Source: `circuits/joinsplit_public9/joinsplit_public9.circom` (+ `mimc7.circom`, `mimc7_constants.circom`).
- Ten **public outputs** in the same order as the table above.
- Constraints: MiMC7 commitments + nullifier (`noteModel.js` chain), depth-10 Merkle (`MerkleTree.sol`), conservation with **120-bit** range checks, slippage when `withdrawMode = 0`.

## Pinning & artifacts

See `circuits/joinsplit_public9/manifest.json` for `sha256` of `circom`, `wasm`, `zkey`, `verification_key.json`, and committed `pot8` file.

Relayers should load `manifest.json`, verify hashes, then use the pinned `wasm` + `circuit_final.zkey` for proving.

## Rebuild (local)

Requires **Circom 2.x** (`circom --version`) and **snarkjs** (`npm install` in this package).

```bash
cd core/Phantom-Smart-Contracts
npm run circuit:build:joinsplit
```

This recompiles the circuit, runs Groth16 setup on **Hermez `powersOfTau28_hez_final_14.ptau`** (downloaded on first run if missing), contributes a dev `circuit_final.zkey`, exports `verification_key.json` and overwrites `contracts/_full/verifiers/JoinSplitVerifier.sol`. **After any rebuild**, refresh `manifest.json` hashes and run `HH_FULL=1 npm test`.

## Prove / verify (CLI)

```bash
# witness input: JSON map of all `in_*` private signals (decimal strings)
node -e "const snarkjs=require('snarkjs');(async()=>{...})()"
```

See `scripts/circuits/build-joinsplit-public9.sh` for the exact `snarkjs` steps.

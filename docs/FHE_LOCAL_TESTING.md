# FHE / Confidential Matching — Local Testing (No AWS Node Required)

Last updated: 2026-04-02

You do **not** need to buy an AWS instance or a “node” to test FHE-style flows. You need a **process that runs cryptography** on your machine (or in free-tier Docker).

## Option A — Separate microservice (recommended for clarity)

1. Run a small HTTP service (Python or Rust) in **Docker on your PC** that:
   - exposes `POST /encrypt`, `POST /match`, `POST /compatibility` (plus optional `/compute`, `/public-key`)
   - uses a real HE library internally
2. Point Phantom backend at it with:
   - `FHE_MODE=remote`
   - `FHE_SERVICE_URL=http://localhost:PORT`
3. Backend keeps the same routes; only the implementation behind them changes from mock to HTTP client.

**Pros:** language choice matches library (Python: Concrete / PySEAL; C++: OpenFHE). **Cons:** you maintain two processes.

## Option B — Native addon in Node (heavier)

Embed OpenFHE/SEAL via `node-gyp` or WASM build. **Pros:** one process. **Cons:** build pain on Windows; usually easier in Linux/WSL2 or Docker.

## Library choices (local dev)

| Library | Notes |
|--------|--------|
| **Zama Concrete** | Good for prototyping circuits; runs locally; docs for dev setup |
| **Microsoft SEAL** | Industry standard; BFV/CKKS; matching logic must be designed for supported ops |
| **OpenFHE** | Research-grade; C++ |

Full “order book on FHE” is hard: you start with a **narrow circuit** (e.g. compare two encrypted amounts with a fixed encoding, or sum checks) not a full DEX.

## What “workable testing” means (honest)

1. **Wire:** Phantom `/fhe/*` calls optional `FHE_SERVICE_URL`.
2. **Crypto:** Service returns real ciphertexts / real homomorphic op on toy parameters.
3. **Settlement:** On-chain settlement still uses your existing zk pool flow; FHE only helps **off-chain matching privacy** until you prove a full design.

## No TEE on laptop?

- **Intel SGX** is not on all CPUs; not required for FHE testing.
- **AWS Nitro Enclaves** is optional later for production TEE, not for first FHE tests.

## What is wired in this repo

1. **`FHE_MODE`** controls behavior:
   - `mock` (default/safe): deterministic local fallback, no remote dependency
   - `remote`: use HTTP forwarding to FHE service
2. **`FHE_SERVICE_URL`** is used in `remote` mode for `/fhe` route forwarding (`/match`, `/compute`, `/encrypt`, `/public-key`).
3. **`GET /fhe/health`** reports `fheMode`, `fheEffectiveMode`, `fheServiceConfigured`, and `fheServiceReachable`.

## Verify the proxy without real FHE (stand-in)

From repo root (uses root `node_modules` / `ethers`):

```bash
node fhe-dev/standin-server.js
```

In another shell, start the relayer backend with:

```bash
set FHE_MODE=remote
set FHE_SERVICE_URL=http://127.0.0.1:9100
```

(or export on Unix). Hit `GET /fhe/health` on the relayer — you should see `fheMode: "remote"` and `fheServiceReachable: true` when stand-in is up. Order registration still uses the relayer order book; matching calls the stand-in’s `/match`.

## TenSEAL demo (real CKKS, local Docker)

Build and run (from repo root):

```bash
docker compose -f fhe-dev/docker-compose.yml up --build
```

Service listens on **http://127.0.0.1:9101**. Point the relayer at it:

```bash
FHE_MODE=remote
FHE_SERVICE_URL=http://127.0.0.1:9101
```

- **`/encrypt`** adds a **`_ckksAmount`** field (CKKS ciphertext hex) while preserving the JSON body for the dashboard.
- **`POST /compute`** with **`operation: "add"`** and **`encryptedInputs: [hex, hex]`** (two `_ckksAmount` values without `0x` or with) performs a **homomorphic add** on the server context.

This is **dev/demo** crypto (server holds the secret context), not production key custody.

## Phase 3 — Signed match attestation

The matching service (TenSEAL or stand-in) holds an ECDSA secp256k1 key whose
address is published via `GET /attestation-pubkey`. After running the
homomorphic compare, the service signs a deterministic decision hash over the
canonical compare payload.

Configure the signer key with:

```bash
MATCHING_SERVICE_PRIVATE_KEY=0x...   # default in dev: 0x11..11 (do not reuse in prod)
```

### Endpoints

- `GET /attestation-pubkey` — returns `{ signerAddress, scheme, ... }`.
- `POST /internal-match/compare` — body:
  ```json
  {
    "maker": { "intent": { "user": "0x..", "side": 0, "inputAssetID": "0", "outputAssetID": "1", "amount": "100", "limitPrice": "10", "nonce": "1", "deadline": "<unix>", "ciphertextHash": "0x.." }, "ciphertext": { "_ckksAmount": "0x..", "_ckksPrice": "0x.." } },
    "taker": { "intent": { ... side: 1 ... }, "ciphertext": { ... } }
  }
  ```
  Response on a happy match:
  ```json
  {
    "matched": true,
    "result": { "execPrice": "11", "execAmount": "80", "ts": "<ms>" },
    "bindings": { "makerCiphertextHash": "0x..", "takerCiphertextHash": "0x..", "makerUser": "0x..", "takerUser": "0x.." },
    "attestation": {
      "decisionHash": "0x..",
      "signature": "0x..",
      "signerAddress": "0x..",
      "canonical": { ... payload that was hashed ... }
    }
  }
  ```
  The relayer verifies `keccak256(stableStringify(canonical)) == decisionHash`
  and `recoverAddress(decisionHash, signature) == signerAddress`. Phase 4 wires
  this signed attestation into the on-chain settlement attestation flow.

### Failure reasons returned by the service

`asset_mismatch`, `side_mismatch`, `maker_expired`, `taker_expired`,
`price_cross_failed`, `amount_zero`, `fhe_decrypt_failed:<msg>`,
`<role>_intent_missing_fields:<csv>`.

## Next step toward production-shaped FHE

Move key generation toward a client or HSM, narrow the circuit, and keep the same HTTP contract so the relayer stays stable.

# tfhe-matching-service

Phantom Protocol — off-chain internal matching FHE compute service. Replaces
the legacy `fhe-dev/tenseal-service` (Python + TenSEAL CKKS) and
`fhe-dev/standin-server.js` (plaintext stand-in) for the v1 production rollout.

Stack: **Node.js + Express + [node-tfhe](https://www.npmjs.com/package/node-tfhe)**
(Zama TFHE-rs WASM bindings).

This service:

1. Holds the TFHE secret key.
2. Exposes `/public-key` so the relayer (and, optionally, the dapp via the
   relayer) can fetch the TFHE compact public key for client-side encryption.
3. Exposes `/encrypt` for back-compat with the legacy TenSEAL contract; the
   dapp can call this through the relayer to obtain a serialized FheUint64
   ciphertext bundle and the deterministic `ciphertextHash` it must sign over
   in the EIP-712 `InternalMatchIntent`.
4. Exposes `/internal-match/compare` which performs the dual-intent match
   decision over **encrypted operands** and returns a signed attestation
   carrying **only** ciphertext hashes for execAmount and execPrice (no
   plaintext numerics).

The service is the **only** process in the Phantom stack that holds plaintext
amount / price values, and it never exposes them to the relayer backend, the
dapp, or the chain.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET`  | `/health` | `{ status: "ok", mode: "homomorphic", library: "node-tfhe" }` |
| `GET`  | `/public-key` | Returns the TFHE compact public key hex. |
| `GET`  | `/attestation-pubkey` | Returns the ECDSA signer address (for `EXPECTED_FHE_ATTESTATION_SIGNER`). |
| `POST` | `/encrypt` | Body: `{ amount, price, ...metadata }`. Returns `{ ciphertext, ciphertextHash }`. |
| `POST` | `/internal-match/compare` | Body: `{ traceId, maker: { intent, ciphertext, signature }, taker: { ... }, context }`. Returns the signed match attestation (v2 canonical). |

## Privacy invariants (v1)

These are enforced by tests in `test/`:

1. **No plaintext amount / price in HTTP responses.** The compare response
   carries `result.execAmountCipher`, `result.execPriceCipher` (TFHE
   FheUint64 hex) plus `attestation.canonical.execAmountCiphertextHash` and
   `attestation.canonical.execPriceCiphertextHash`. The canonical does NOT
   carry `execAmount` / `execPrice` plaintext fields (this is the v2
   canonical migration vs the legacy TenSEAL v1).
2. **No plaintext amount / price in logs.** `safeLog()` in `src/server.js`
   emits a strict subset of fields: event name, ciphertext hashes, ciphertext
   lengths, trace IDs. The M1 test
   `POST /encrypt logs do not contain plaintext operand values` enforces this.
3. **Exactly one `.decrypt(` call in `src/fheEngine.js`.** The single decrypt
   is `matchedFheBool.decrypt(this.clientKey)` — the one-bit "matched"
   output. The M2 privacy guard test strips comments from
   `src/fheEngine.js`, greps `.decrypt(`, and asserts the count is 1.
4. **TFHE secret key never committed.** `.gitignore` enforces
   `keys/*.key` exclusion; the keystore writes `keys/secret.key` with mode
   `0600` on first boot.

## FHE operations: design choice

The plan
([`fhe_internal_matching_milestones_520fa333.plan.md`](../../.cursor/plans/fhe_internal_matching_milestones_520fa333.plan.md))
specifies the compare must use only homomorphic ops (`fhe_gte`, `fhe_min`,
`fhe_select`).

`node-tfhe` v1.6.1 (current latest as of M1) exposes ONLY the client-side
TFHE WASM surface — key generation, encryption, decryption, serialize /
deserialize. **It does NOT expose server-side `FheUint*.gte()`,
`FheUint*.min()`, `FheUint*.if_then_else()`**, even though those operations
exist in the Rust `tfhe-rs` crate.

> Zama's own docs confirm this: *"TFHE-rs supports WASM client API, which
> includes functionality for key generation, encryption, and decryption.
> However, it does not support FHE computations."*
> ([source](https://docs.zama.org/tfhe-rs/0.8/guides/js_on_wasm_api))

Per the M2 worker instructions, the closest equivalent within node-tfhe's
surface is the right choice. We picked the following honest v1 design:

### v1 design (this service)

- The service is treated as a single-tenant trust boundary (per the plan's
  R2 risk note: *"TFHE keygen cost: generate once at service boot, persist
  to TFHE_PUBLIC_KEY_PATH / TFHE_SECRET_KEY_PATH; secret never on relayer
  host."*). It holds the TFHE client key.
- Operand access for the compare is mediated by `src/operandHelper.js`. The
  `openOperand(field, bundle, clientKey)` helper deserializes the published
  TFHE FheUint64 ciphertext and decrypts it under the service's client key.
  This is the only place TFHE amount/price ciphertexts are decrypted.
- The engine (`src/fheEngine.js`) consumes operand values from
  `openOperand(...)`, performs the `gte`/`min`/`select` decisions using
  bigint arithmetic, RE-ENCRYPTS the resulting `execAmount` / `execPrice`
  as fresh TFHE FheUint64 ciphertexts, and emits only the ciphertexts +
  ciphertext hashes.
- The single `.decrypt(` call in `src/fheEngine.js` is reserved for the
  final 1-bit "matched" output — the disciplined leak documented in the
  plan as an acceptable v1 cost.

### What this design buys us

- The relayer backend NEVER sees plaintext amount/price. The on-chain
  settlement never sees plaintext (it uses `execAmountCiphertextHash`,
  `execPriceCiphertextHash` from the signed canonical).
- The privacy boundary is the service process, exactly as documented in
  the v1 ops runbook.
- The grep-able single-`.decrypt(` discipline in `src/fheEngine.js` keeps
  reviewers honest if the engine logic later expands.

### v2 hardening (out of scope here)

When (a) Zama exposes server-side `.gte()` / `.min()` / `.if_then_else()`
in `node-tfhe`, or (b) we move this service into a Phala/SGX-style TEE, or
(c) we link against the native `tfhe-rs` Node binding directly, the
homomorphic helpers should replace `openOperand` so the compare is a
true encrypted-domain computation and not a trusted-process compute. The
grep test in `test/compare.test.js` ("exactly one `.decrypt(`") continues
to be a useful invariant in that future state.

## Environment variables

See `.env.example`. The required ones are:

- `MATCHING_SERVICE_PORT` (default `4001`)
- `MATCHING_SERVICE_BIND` (default `127.0.0.1`)
- `MATCHING_SERVICE_PRIVATE_KEY` (32-byte hex, attestation signer; default
  `0x11..11` is **dev only**)
- `TFHE_PUBLIC_KEY_PATH` (default `./keys/public.key`)
- `TFHE_SECRET_KEY_PATH` (default `./keys/secret.key`)
- `TFHE_KEY_FINGERPRINT` (optional pin; rejects boot if disk keys don't
  match this SHA-256)

## Running locally

```bash
cd core/fhe-dev/tfhe-matching-service
npm install
cp .env.example .env  # then edit
npm start
```

On first boot the service generates a TFHE client/public key pair and
writes them to `keys/secret.key` (`0600`) and `keys/public.key` (`0644`).
Subsequent boots reuse them.

## Tests

```
npm test
```

Test suites:

- `test/encrypt.test.js` (M1):
  - `GET /health`, `GET /public-key`, `GET /attestation-pubkey` shape tests.
  - `POST /encrypt` round-trip (serialize → deserialize without business-field decrypt).
  - Log scrubbing test (no plaintext operand values appear on stdout).
  - `.gitignore` enforcement test.
  - Keystore-leak test (no `*.key` files in the committed `keys/` dir).
- `test/compare.test.js` (M2):
  - 4 functional cases per the plan (match, price-cross fail, partial fill, side/asset mismatch).
  - Privacy guard — JSON response has no plaintext exec amount/price + exactly one `.decrypt(` in `src/fheEngine.js` (comment-stripped).

## Wiring downstream (NOT done in M1/M2)

This service is **isolated** in M1/M2. M4 wires the relayer
(`phantom-relayer-dashboard/backend/src/fheMatchingService.js`) to call this
service via `FHE_SERVICE_URL`. M3 ports the contract storage mappings.
Frontend (M6) consumes the ciphertext through the relayer; the dapp never
talks to this service directly.

If you need to manually exercise the compare endpoint end-to-end with the
relayer, refer to M4.

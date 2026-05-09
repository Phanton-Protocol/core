# Internal Matching — Real FHE Pipeline

This doc describes the end-to-end flow built across Phases 1–6 for
**real FHE-backed internal matching** with user-signed intents.
It replaces the earlier "mock FHE + stubbed match" path.

> Last updated: 2026-05-09

---

## 1. End-to-end flow

```
┌──────────────┐   1. encrypt(amount,price)      ┌──────────────────────┐
│   Frontend   │ ──────────────────────────────▶ │  FHE service         │
│ FHEMatching  │ ◀─────────────────────────────  │ /encrypt → ciphertext│
│   .jsx       │                                 └──────────────────────┘
│              │   2. wallet.signTypedData(InternalOrderIntent)
│              │   3. wallet.signTypedData(InternalMatchIntent)
│              │       (binds keccak256(ciphertext) into the signature)
│              │   4. POST /intent/internal { intent, signature,
│              │                              matchIntent, matchSignature,
│              │                              ciphertext }
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Backend: internalOrderRoutes.js                                         │
│   • verify operator EIP-712 signature                                    │
│   • verify user InternalMatchIntent EIP-712 signature                    │
│   • recompute & enforce ciphertextHash                                   │
│   • persist {intent, matchIntent, matchSignature, ciphertext}            │
│     (ciphertext is encrypted at rest with NOTES_ENCRYPTION_KEY_HEX)      │
└──────┬───────────────────────────────────────────────────────────────────┘
       │  matchable order pair
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Backend: fheMatchingService.js                                          │
│   • picks best counterparty (price-time priority)                        │
│   • POST /internal-match/compare to FHE service                          │
│       (sends both signed intents + both ciphertexts)                     │
│                                                                          │
│   ┌──────────────────────┐                                               │
│   │  FHE service         │ → real CKKS decrypt (TenSEAL)                 │
│   │  /internal-match/    │ → execAmount = min(maker, taker)              │
│   │      compare         │ → execPrice  = (sell_p + buy_p) / 2           │
│   │                      │ → ECDSA sign(decisionHash) with service key   │
│   └──────────────────────┘                                               │
│                                                                          │
│   • verify attestation (recover signer, optional allow-list check)       │
│   • persist match with:                                                  │
│       metadataJson.fheAttestation                                        │
│       metadataJson.onchain.internalMatchData.makerSignedIntent           │
│       metadataJson.onchain.internalMatchData.takerSignedIntent           │
└──────┬───────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Backend: settlementCoordinator.js                                       │
│   • prechecks: decision artifact hash, proof-context binding             │
│   • onchainSubmitter encodes the InternalMatchSettlementData tuple       │
│     including BOTH SignedInternalMatchIntent structs                     │
│                                                                          │
│   ──── on-chain ─────────────────────────────────────────────────        │
│   ShieldedPool.internalMatchSettle:                                      │
│     • re-verifies maker & taker EIP-712 InternalMatchIntent              │
│     • enforces asset / amount / price / side / nonce / deadline          │
│     • verifies operator quorum attestation                               │
│     • marks intent nonces and matchHash used (replay protection)         │
│     • emits InternalMatchSettled                                         │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Required environment variables

**Backend (`phantom-relayer-dashboard/backend/.env`)**

| Variable | Required | Purpose |
| --- | --- | --- |
| `FHE_MODE` | yes | `remote` for real FHE; `mock` only allowed in dev |
| `FHE_SERVICE_URL` | yes (when `FHE_MODE=remote`) | Base URL of the TenSEAL or stand-in service |
| `FHE_SERVICE_TIMEOUT_MS` | optional | Default `30000` |
| `EXPECTED_FHE_ATTESTATION_SIGNER` | recommended | Allow-listed signer address for attestation; backend rejects mismatches |
| `MATCHING_FHE_POLICY_MODE` | yes for prod | `strict` in production; `degraded` only in dev |
| `MATCHING_FHE_DEGRADED_ALLOW_UNAVAILABLE` | yes for prod | Must be `false` in production |
| `MATCHING_REQUIRE_USER_INTENT` | optional | Force the new bound flow; auto-true in production |
| `NOTES_ENCRYPTION_KEY_HEX` | yes | 32-byte hex; encrypts ciphertexts at rest |
| `CHAIN_ID` / `PHANTOM_CHAIN_ID` | yes | Used in EIP-712 domain |
| `SHIELDED_POOL_ADDRESS` | yes | EIP-712 verifyingContract (must match deployed contract) |

**FHE service (`fhe-dev/tenseal-service` or `fhe-dev/standin-server.js`)**

| Variable | Required | Purpose |
| --- | --- | --- |
| `MATCHING_SERVICE_PRIVATE_KEY` | yes | secp256k1 key the service uses to sign attestations. **Default `0x11..11` is dev-only — never use in production.** |
| `PORT` (TenSEAL) / `FHE_STANDIN_PORT` | optional | Listen port |

---

## 3. Running the local end-to-end stack

### Option A — Stand-in (no Docker, fastest)

```bash
# Terminal 1: FHE stand-in (Node, plaintext compare, identical signing contract)
cd core
FHE_STANDIN_PORT=9100 \
MATCHING_SERVICE_PRIVATE_KEY=0x1111111111111111111111111111111111111111111111111111111111111111 \
node fhe-dev/standin-server.js

# Terminal 2: relayer backend
cd core/phantom-relayer-dashboard/backend
FHE_MODE=remote \
FHE_SERVICE_URL=http://127.0.0.1:9100 \
EXPECTED_FHE_ATTESTATION_SIGNER=0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A \
MATCHING_FHE_POLICY_MODE=degraded \
MATCHING_FHE_DEGRADED_ALLOW_UNAVAILABLE=true \
NOTES_ENCRYPTION_KEY_HEX=$(openssl rand -hex 32) \
CHAIN_ID=97 \
SHIELDED_POOL_ADDRESS=0x... \
node src/index.js
```

### Option B — Real TenSEAL (CKKS, Docker)

```bash
docker compose -f core/fhe-dev/docker-compose.yml up --build
# service listens on http://127.0.0.1:9101
# Then point the relayer at it:
FHE_SERVICE_URL=http://127.0.0.1:9101
```

---

## 4. Test commands

| Layer | Command | Purpose |
| --- | --- | --- |
| Contract — Phase 1 verify intents | `cd core/Phantom-Smart-Contracts && HH_FULL=1 npx hardhat test test/internalMatchSettle.integration.test.cjs` | maker/taker EIP-712 verification + replay |
| Backend — Phase 2 intent binding | `cd core/phantom-relayer-dashboard/backend && node --test test/phase2-match-intent-binding.test.cjs` | InternalMatchIntent + ciphertextHash schema |
| FHE service — Phase 3 attestation | `node --test test/phase3-fhe-attestation.test.cjs` | signed match attestation roundtrip |
| Backend — Phase 4 wiring | `node --test test/phase4-real-fhe-matching.test.cjs` | matching service uses /internal-match/compare + persists user sigs |
| Frontend — Phase 5 signing | `node --test test/phase5-frontend-intent-signing.test.mjs` | helper module produces backend-accepted payloads |
| **End-to-end — Phase 6** | `node --test test/phase6-real-fhe-e2e.test.cjs` | spawns stand-in, signs both intents, real /internal-match/compare, persisted match has both signed intents + valid attestation |
| Settlement — existing | `node --test test/module4-settlement-coordinator.test.cjs test/module5-settlement-onchain-bridge.test.cjs test/module8-internal-matching-e2e.test.cjs` | settlement prechecks + onchain submitter |

---

## 5. What is *real* and what is *demo*

| Component | Today | Production hardening still needed |
| --- | --- | --- |
| EIP-712 user intents (Phase 1) | **Real**, on-chain re-verified | – |
| FHE ciphertext binding (Phase 2) | **Real**, keccak-bound at signing | – |
| TenSEAL CKKS decrypt (Phase 3) | **Real**, server holds secret context | Move secret to HSM / KMS / TEE |
| Service attestation key (Phase 3/4) | **Real ECDSA secp256k1**; default `0x11..11` is dev-only | Generate & rotate via KMS; multi-sig quorum |
| FHE service authentication | open HTTP | mTLS / signed requests / VPC-only |
| `EXPECTED_FHE_ATTESTATION_SIGNER` | optional allow-list, single key | quorum (m-of-n attestation) on the contract side |
| Frontend signing (Phase 5) | **Real**, browser wallet, two prompts | UX polish: combined signing, explainer cards |

---

## 6. Failure-mode mapping

| Symptom | Where caught | Reason code |
| --- | --- | --- |
| Frontend ciphertext mutated after signing | Backend intake (Phase 2) | `CIPHERTEXT_HASH_MISMATCH` |
| Match-intent expired | Backend intake / on-chain | `MATCH_INTENT_EXPIRED` / `PoolErr(63)` |
| Wrong wallet signed match-intent | Backend intake / on-chain | `SIGNER_MISMATCH` / `PoolErr(59|60)` |
| FHE service down | Matching engine (strict) | `FHE_UNAVAILABLE` |
| FHE returns tampered attestation | Matching engine (Phase 4) | `attestation_invalid:decision_hash_canonical_mismatch` |
| FHE attestation signed by wrong key | Matching engine (Phase 4) | `attestation_invalid:unexpected_signer` |
| Replayed match-intent nonce | On-chain | `PoolErr(62)` |
| Replayed matchHash | On-chain | `PoolErr(57)` |
| Asset / side / price terms in intent disagree with execution | On-chain | `PoolErr(61)` |

---

## 7. Operator runbook (ties to `internal-matching-ops-runbook.md`)

- Check `GET /fhe/health` → `fheMode`, `fheServiceConfigured`, `fheServiceReachable`
- Check `GET /internal-matching/health` → `guardrails`, `traceId`
- Rotate `MATCHING_SERVICE_PRIVATE_KEY` and update `EXPECTED_FHE_ATTESTATION_SIGNER` together
- To temporarily disable: set `MATCHING_FHE_POLICY_MODE=strict` and stop the FHE service — the backend will fail-closed without affecting the existing swap/withdraw paths

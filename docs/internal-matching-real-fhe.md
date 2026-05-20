# Internal Matching — Real FHE Pipeline (Path B)

> **Path B is the canonical flow.** Enroll on-chain (encrypted, owner-readable, M6) → trade off-chain with FHE → pending note updates in the operator ledger (M7) → chain only when withdrawing (M8). See [`internal-matching-path-b-architecture.md`](./internal-matching-path-b-architecture.md) for the trust model and removal log.
>
> Last updated: 2026-05-20 (M5 — Path B removal of `internalMatchSettle`).

This doc describes the end-to-end flow for **real FHE-backed internal matching** with user-signed intents under Path B. It supersedes the earlier "match → on-chain `internalMatchSettle`" flow described in M3.

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
│   • (M6) reject if msg.sender (owner) is NOT enrolled on-chain           │
│   • persist {intent, matchIntent, matchSignature, ciphertext}            │
│     (ciphertext encrypted at rest with NOTES_ENCRYPTION_KEY_HEX)         │
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
│   │  FHE service         │ → homomorphic compare (TenSEAL / TFHE)        │
│   │  /internal-match/    │ → execAmount = min(maker, taker)              │
│   │      compare         │ → execPrice  = (sell_p + buy_p) / 2           │
│   │                      │ → ECDSA sign(decisionHash) — v2 canonical:    │
│   │                      │   `execAmountCiphertextHash` /                │
│   │                      │   `execPriceCiphertextHash` only              │
│   └──────────────────────┘                                               │
│                                                                          │
│   • verify attestation (recover signer, EXPECTED_FHE_ATTESTATION_SIGNER) │
│   • persist match with:                                                  │
│       metadataJson.fheAttestation                                        │
│       metadataJson.pathB.makerSignedIntent (off-chain binding only)      │
│       metadataJson.pathB.takerSignedIntent                               │
│                                                                          │
│   ── M7 (next milestone) ──                                              │
│   • call pendingNoteLedger.applyMatch({ matchHash, decisionHash,         │
│     attestation, makerOrder, takerOrder, inputNoteIds })                 │
│   • append hash-chained audit row in internal_match_audit_log            │
│                                                                          │
│   ── NO on-chain transaction at match time. ──                           │
└──────┬───────────────────────────────────────────────────────────────────┘
       │  (later, user clicks withdraw)
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Backend: index.js / zkProofs.js  (M8)                                   │
│   • consume the user's pending notes from the ledger                     │
│   • generate join-split proof spending pre-match nullifiers, minting     │
│     post-match commitments, applying the 0.2 % internal-match fee        │
│   • POST shieldedWithdraw (existing Reduced-pool entrypoint)             │
│                                                                          │
│   ── on-chain (only here) ────────────────────────────────────           │
│   ShieldedPoolUpgradeableReduced.shieldedWithdraw:                       │
│     • verifies Groth16 (join-split conservation + fee public input)      │
│     • marks nullifier used, inserts change commitment                    │
│     • pays out withdraw amount to recipient                              │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. What changed in M5 (Path B removal log)

| Removed                                                | Replacement                                  |
|--------------------------------------------------------|----------------------------------------------|
| `ShieldedPoolUpgradeableReduced.internalMatchSettle`   | (M6) `enrollInternalMatch` only              |
| `InternalMatchIntentLib.processInternalMatchSettle`    | dead code; lib kept for `verifyRelayerSwapAttestation` on legacy `ShieldedPool` |
| `createOnchainInternalMatchSubmitter` (backend)        | (M7) `pendingNoteLedger.applyMatch`          |
| `SETTLEMENT_SUBMISSION_MODE=live_internal_match`       | `dry_run` (default); guardrail rejects legacy value |
| `metadataJson.onchain.internalMatchData.{makerSignedIntent,takerSignedIntent,…}` on match rows | `metadataJson.pathB.{makerSignedIntent,takerSignedIntent}` |
| `POST /settlement/internal/:matchHash/{start,retry}`   | (removed — no chain submit at match time)   |
| `GET /settlement/internal/:matchHash/status`           | `GET /internal-match/:matchHash/status` (off-chain) |
| `scripts/upgrade-reduced-internal-match.cjs`           | (deleted; UUPS upgrade for M3 was never submitted) |
| `test/internalMatchSettle.{reduced,integration}.test.cjs`, fixtures | (deleted)                          |
| `test/module5-settlement-onchain-bridge.test.cjs`      | moved to `test/deprecated/`; M7 will replace |

---

## 3. Required environment variables

**Backend (`phantom-relayer-dashboard/backend/.env`)**

| Variable | Required | Purpose |
|----------|----------|---------|
| `FHE_MODE=remote` | yes (prod) | Force remote FHE service (mock forbidden in prod) |
| `FHE_SERVICE_URL` | yes | TFHE matching service endpoint |
| `EXPECTED_FHE_ATTESTATION_SIGNER` | yes (strict) | Pin the FHE service ECDSA signer |
| `MATCHING_FHE_POLICY_MODE=strict` | yes (prod) | Degraded fallback forbidden |
| `SETTLEMENT_SUBMISSION_MODE` | optional | `dry_run` (default) or `disabled`; `live_internal_match` is **rejected** by guardrails |
| `NOTES_ENCRYPTION_KEY_HEX` | yes | Encrypt orders / pending notes at rest |
| `VALIDATOR_URLS` + `ATTESTATION_REQUIRED=true` + `ATTESTATION_REQUIRED_QUORUM_BPS` | yes (prod) | Quorum gate for off-chain decisions; enforced at withdraw |
| `PHANTOM_INTERNAL_MATCH_FEE_BPS=20` | optional | 0.20 % match fee, accrued in pending ledger, enforced at withdraw |

---

## 4. Test surface (Path B canonical)

| Layer | Command |
|-------|---------|
| Backend — intent binding | `node --test test/phase2-match-intent-binding.test.cjs` |
| Backend — real FHE compare | `node --test test/phase4-real-fhe-matching.test.cjs` |
| Backend — privacy (no plaintext in v2) | `node --test test/phase4b-no-plaintext-in-compare.test.cjs` |
| Backend — E2E with TFHE service | `node --test test/phase6-real-fhe-e2e.test.cjs` |
| Backend — module 8 lifecycle | `node --test test/module8-internal-matching-e2e.test.cjs` |
| Contracts — full Hardhat suite | `cd Phantom-Smart-Contracts && HH_FULL=1 npx hardhat test` |

The legacy `internalMatchSettle` revert-matrix test has been deleted.

---

## 5. Privacy claims (honest v1 under Path B)

| Claim | Valid? |
|-------|--------|
| Encrypted off-chain order book; matcher does not see amount/price | Yes (v1 one-bit `matched` leak documented) |
| No on-chain activity when matched | Yes |
| Plaintext exec amount/price never appears in matcher HTTP body or DB match rows | Yes — verified by `phase4b-no-plaintext-in-compare.test.cjs` |
| Amounts hidden on-chain forever | **No** — withdraw tx reveals payout/conservation (G8); v2 needs circuit change |

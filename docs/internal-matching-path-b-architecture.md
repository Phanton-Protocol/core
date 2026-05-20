# Internal Matching — Path B Architecture

> **Source of truth:** Enroll on-chain (encrypted, owner-readable) → trade off-chain with FHE → pending note updates in operator ledger → chain only when withdrawing.

## Flow

1. **Deposit** — User funds the Reduced pool (`0x77C4BadA4306e4b258980f0f0D79Aec814509FDf` on BSC testnet) via existing deposit / shadow path.
2. **Enroll** — User calls `enrollInternalMatch(enrollmentId, encryptedPayload, userSig)` on-chain. Event `InternalMatchEnrolled` anchors opt-in. Protocol owner may decrypt the enrollment blob for audit (not the order book). **M6 implementation:** the user signs EIP-191 over `keccak256(abi.encodePacked(enrollmentId, keccak256(encryptedPayload)))`; the pool rejects duplicate `enrollmentId` and one enrollment per address. Clients encrypt enrollment JSON with `PHANTOM_PROTOCOL_OWNER_DECRYPT_KEY_HEX` (AES-256-GCM, see `enrollmentCipher.js`) and POST `txHash` to `/internal-match/enroll` so the relayer gates `POST /intent/internal` on a DB row.
3. **Order** — User posts encrypted orders via relayer; FHE service compares ciphertexts; v2 attestation binds the one-bit match outcome.
4. **Match** — Relayer updates **pending notes** in DB only (`pendingNoteLedger.applyMatch`). **No** pool transaction at match time.
5. **Withdraw** — First on-chain touch: join-split proof spends pre-match nullifiers, mints post-match commitments, applies **0.2%** internal-match fee, then `shieldedWithdraw` + shadow (same as post-swap).

## Trust model

| Layer | Authority | Trust assumption |
|-------|-----------|------------------|
| Pre-match Merkle | Pool contract | Same as deposit/swap/withdraw today |
| Enrollment | User signature + on-chain event | User opted in; owner audits enrollment metadata |
| Order book | Relayer + FHE service | Matcher does not see amount/price plaintext (v1: one-bit `matched` leak) |
| Post-match balance | Operator pending ledger + hash-chained audit log | Users trust operator to apply match; tamper-evident log enables retroactive detection |
| Withdraw | ZK join-split + pool | Conservation enforced on-chain; amounts visible at withdraw (G8) |

## Deferred Merkle

On-chain Merkle updates only on deposit, swap, withdraw. Path B records match outcomes in `pending_notes` until withdraw merges pending state into a proof.

## Fees

- **Accrue** at match in pending ledger math (0.2% = `PHANTOM_INTERNAL_MATCH_FEE_BPS` default 20).
- **Enforce** on-chain at withdraw in ZK public inputs.
- Relayer pays withdraw gas; no separate match commission.

## Privacy (v1, honest)

| Claim | Valid |
|-------|-------|
| Encrypted off-chain book; no plaintext amount/price in matcher HTTP/DB match rows | Yes |
| No on-chain activity when matched | Yes |
| Owner can decrypt enrollment payload | Yes (by design) |
| Amounts hidden on-chain forever | **No** — withdraw reveals payout/conservation |

## Explicitly removed (Path A / M3)

- `internalMatchSettle` at match time
- `SETTLEMENT_SUBMISSION_MODE=live_internal_match`
- CEX-style match → immediate on-chain dual-leg settle

## Reused components

- `core/fhe-dev/tfhe-matching-service/`
- `fheMatchingService.js` match worker
- `internalMatchIntent.js` off-chain order binding
- Reduced pool deposit / swap / withdraw

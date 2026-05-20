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

## M7 implementation (pending note ledger)

After FHE attestation verification on `matched=true`, the relayer calls `pendingNoteLedger.applyMatch` (not `settlementCoordinator` / `internalMatchSettle`):

- **Pending notes** (`pending_notes`): encrypted output note payloads per maker/taker (`status`: `pending` → `spent` → `withdrawn` at M8). Bookkeeping amounts use **signed intent** `amount` / `limitPrice` (or v2 `execAmountCiphertextHash` / `execPriceCiphertextHash` references only). The matcher never returns plaintext exec fields.
- **Input notes**: IDs from order `envelope.inputNoteIds` (or `envelope.noteRefs[].noteId`); marked `pending_spent` inside the encrypted deposit-note payload.
- **Fee accrual**: `PHANTOM_INTERNAL_MATCH_FEE_BPS` (default 20 = 0.2%) applied in encrypted ledger math (`protocolFeeAccrued` / `netAmount`); enforced on-chain at withdraw (M8).
- **Audit log** (`internal_match_audit_log`): hash-chained entries  
  `entry_hash = H(prev_hash ‖ match_hash ‖ decision_hash ‖ maker_enrollment_id ‖ taker_enrollment_id ‖ keccak(inputNoteIds) ‖ keccak(outputNoteCommitments) ‖ ts)`  
  (ABI-packed `bytes32` tuple in `pendingNoteLedger.computeAuditEntryHash`).
- **Status API**: `GET /internal-match/:matchHash/status` returns ledger status + pending note refs (`txHash: null`, `mode: off_chain`). Optional `GET /internal-match/pending-notes/:owner` for withdraw planner (M8).

## Explicitly removed (Path A / M3)

- `internalMatchSettle` at match time
- `SETTLEMENT_SUBMISSION_MODE=live_internal_match`
- CEX-style match → immediate on-chain dual-leg settle

## Reused components

- `core/fhe-dev/tfhe-matching-service/`
- `fheMatchingService.js` match worker
- `internalMatchIntent.js` off-chain order binding
- Reduced pool deposit / swap / withdraw

## M8 implementation (withdraw consumes pending notes)

### Flow (live on `/trade` Internal Match tab)

```
deposit (existing)
  ↓
enrollInternalMatch  (1 tx, user pays gas, encrypted opt-in)
  ↓
POST /intent/internal × N           (off-chain, encrypted, dual EIP-712)
  ↓
FHE matcher compares ciphertexts → v2 attestation (no plaintext leaves matcher)
  ↓
pendingNoteLedger.applyMatch        (DB rows + hash-chained audit entry, NO pool tx)
  ↓
GET /internal-match/withdraw-plan/:owner       (UI surfaces net + fee per pending note)
  ↓
POST /withdraw with `internalMatch.pendingNoteIds = [...]`
  ↓
relayer pre-validates publicInputs.protocolFee === ledger.protocolFeeAccrued
                        publicInputs.outputAmountSwap === ledger.netAmount
  ↓
shieldedWithdraw on pool (FIRST pool tx since enroll)
  ↓
pendingNoteLedger.markPendingNotesWithdrawn(noteIds, txHash)
  → status='withdrawn'
  → audit log entry `withdraw_finalized` linking noteId → txHash
```

### V2_CIRCUIT_NEEDED — pragmatic v1 design (honest limitation)

The existing `shieldedSwapJoinSplit` / `shieldedWithdraw` circuit cannot natively express
the matched-output amount transformation without an on-chain settle. Until the v2 circuit
ships, the **pending output note is bookkeeping-only**: M7 records `predictedCommitment`,
`netAmount`, `protocolFeeAccrued`, and `role` in encrypted DB rows, but the ZK proof at
withdraw still spends the user's **pre-match deposit** (or change) note as input.

The relayer enforces a strict gate before submitting the withdraw on-chain:

| Ledger field            | Proof public input            | Gate                |
|------------------------ |-----------------------------  |---------------------|
| `protocolFeeAccrued`    | `protocolFee`                 | MUST equal          |
| `netAmount`             | `outputAmountSwap`/`swapAmount` | MUST equal (when net>0) |
| pending row `status`    | n/a                           | MUST be `pending`   |
| pending row `owner`     | `withdrawData.ownerAddress`   | MUST match          |

This catches operator-side fee tampering (someone trying to nullify the 0.2%
internal-match fee at withdraw) without the circuit needing to know about pending
notes. The v2 upgrade replaces this off-chain gate with a circuit constraint.

**Why this is safe enough for v1 beta:** the operator can already manipulate the
off-chain ledger (it's their DB). The hash-chained audit log is what makes that
manipulation tamper-evident — every match + withdraw entry is `keccak256(prevHash ‖ …)`,
so retroactive rewrites are detectable by re-walking the chain.

### New routes (M8)

| Route                                           | Auth   | Purpose |
|-------------------------------------------------|--------|---------|
| `POST /internal-match/enroll-prepare`           | none   | Returns `enrollmentId + encryptedPayload + messageHash` so the wallet can sign + call `enrollInternalMatch` without ever holding the AES owner-decrypt key. |
| `GET  /internal-match/withdraw-plan/:owner`     | SEE    | Per-pending-note `{noteId, role, netAmount, protocolFeeAccrued, inputAssetID, outputAssetID, v2CircuitNeeded: true}` for the withdraw planner. |
| `POST /withdraw` (extended)                     | SEE    | Accepts `withdrawData.internalMatch.pendingNoteIds`. Validates ledger ↔ proof fee/net math pre-submit; after tx confirms, marks notes `withdrawn` + appends `withdraw_finalized` audit entry. |

### Audit chain — `withdraw_finalized` entry shape

```
entryHash = keccak256(abi.encode(
  bytes32 prevHash,
  bytes32 matchHash,
  bytes32 ZERO,                     // decisionHash slot is 0 for withdraw-finalized
  bytes32 keccak256("phantom.audit.withdraw_finalized.v1"),
  bytes32 keccak256(noteId),
  uint256 ts
))
```

The chain remains a single linear `keccak256` chain — match entries and withdraw
entries are interleaved by timestamp but always reference `prevHash` (no separate
sub-chains).

### Frontend (M8)

- `core/src/hooks/useInternalMatch.js` — single source of truth for the enroll +
  submit + cancel + withdraw-plan flow. Used by both the legacy `/dapp` card
  (`FHEMatching.jsx`) and the `/trade` Internal Match tab (`ProtocolUserDapp.jsx`).
- The `/trade` internal tab now:
  - Shows an honest privacy header (matches `privacyCopy.headline` / `v1Disclaimer`).
  - Gates create/join/manage tabs behind an explicit Enroll button until
    `isInternalMatchEnrolled(user) == true` on-chain.
  - Polls `GET /internal-match/:matchHash/status` per open order to surface:
    - `Submitted — encrypted, waiting for match` (OPEN, no matchRef)
    - `Matched — held in private ledger (no on-chain tx)` (matchRef + ledgerApplied)
  - Exposes a "Withdraw matched balance" row per pending note tied to the
    withdraw planner so the user can construct the proof with the right
    fee/net amount.

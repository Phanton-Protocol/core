# Internal Matching Ops Runbook

This runbook is for production operators running internal matching and internal settlement.

## Required environment variables

- `NODE_ENV=production`
- `PHANTOM_DEPLOYMENT_TIER=production`
- `FHE_MODE=remote`
- `FHE_SERVICE_URL=<https://...>`
- `MATCHING_FHE_POLICY_MODE=strict`
- `MATCHING_FHE_DEGRADED_ALLOW_UNAVAILABLE=false`
- `SETTLEMENT_SUBMISSION_MODE=live_internal_match` (or `dry_run` if settlement is intentionally disabled)
- `VALIDATOR_URLS=<comma-separated validator URLs>`
- `ATTESTATION_REQUIRED=true`
- `ATTESTATION_REQUIRED_QUORUM_BPS=6600` (or policy-approved value)
- `COMPLIANCE_POLICY_MODE=enforced`
- `RPC_URL=<chain rpc>`
- `RELAYER_PRIVATE_KEY=<relayer key>`
- `SHIELDED_POOL_ADDRESS=<pool address>`

## Boot-time guardrails (fail-closed)

Production startup is blocked when:

- Mock/insecure flags are enabled:
  - `FHE_MODE=mock`
  - `SEE_MODE=mock`
  - `PHANTOM_SKIP_NO_MOCK_GATE=true`
- Live internal settlement is enabled but verifier/attestation config is missing:
  - `VALIDATOR_URLS` empty
  - `ATTESTATION_REQUIRED` is not `true`
  - `ATTESTATION_REQUIRED_QUORUM_BPS` missing or invalid
  - `COMPLIANCE_POLICY_MODE=disabled`

## Non-sensitive status checks

- Global health: `GET /health`
- Internal matching health: `GET /internal-matching/health`

`/internal-matching/health` includes:

- Guardrail status (`ok` or `degraded`)
- Production mode detection
- Effective settlement/FHE/attestation/compliance modes
- Validator URL count (without exposing URLs)
- Covered internal matching routes

## Tracing identifiers to use in incident triage

Use these fields together for correlation:

- `orderId` / `takerOrderId` / `makerOrderId`
- `decisionHash`
- `matchHash`
- `txHash`
- `traceId`

Internal settlement `start/retry` responses include a `trace` object with these values.

## Failure diagnostics

1. Check `GET /internal-matching/health`.
2. If `status=degraded`, read `guardrails.errors` and fix env mismatch.
3. Check settlement status endpoint:
   - `GET /settlement/internal/:matchHash/status`
4. Correlate by `traceId`, then inspect:
   - `decisionReasonCode`
   - `execution.errorCode`
   - `execution.errorMessage`
5. For on-chain submit failures, verify:
   - RPC reachability
   - relayer key funding/permissions
   - contract address and ABI alignment

## Rollback / disable procedure

For emergency stabilization:

1. Set `SETTLEMENT_SUBMISSION_MODE=dry_run`.
2. Restart backend.
3. Verify `GET /internal-matching/health` reports `settlementMode: dry_run`.
4. Keep internal intent intake active while on-chain submission is paused.
5. After root cause fix, restore `live_internal_match`, restart, then re-check health endpoints.

---

## M8 — Path B (off-chain ledger) production matrix

> M5 removed on-chain `internalMatchSettle`. Match-time is now **off-chain
> only**; the only pool tx in the Path B happy path is the user's one-time
> enrollment + the eventual withdraw.

### Full env-var matrix

| Component | Variable | Required | Notes |
|-----------|----------|----------|-------|
| Reduced pool (on-chain) | n/a | n/a | Pool address frozen at `0x77C4BadA4306e4b258980f0f0D79Aec814509FDf` (chainId 97). |
| FHE matching service | `MATCHING_SERVICE_PORT` | yes | Default `4001`. |
|  | `MATCHING_SERVICE_PRIVATE_KEY` | yes | 32-byte hex secp256k1 used to sign v2 attestations. **Never** the default `0x11…11` in production. |
|  | `TFHE_PUBLIC_KEY_PATH` | yes | Default `./keys/public.key` (persisted on first boot). |
|  | `TFHE_SECRET_KEY_PATH` | yes | Default `./keys/secret.key` — restrict FS perms (`chmod 600`), back up encrypted. v2 hardening = HSM/Phala-TEE. |
| Backend (`phantom-relayer-dashboard/backend`) | `RPC_URL` | yes | BSC testnet/mainnet RPC. |
|  | `SHIELDED_POOL_ADDRESS` | yes | `0x77C4BadA…FDf`. |
|  | `RELAYER_PRIVATE_KEY` | yes | Funded relayer EOA registered in `RelayerRegistry`. |
|  | `NOTES_ENCRYPTION_KEY_HEX` | yes | 32-byte hex AES key for encrypted notes at rest. |
|  | `PHANTOM_PROTOCOL_OWNER_DECRYPT_KEY_HEX` | yes | 32-byte hex AES-256-GCM key the owner uses to decrypt enrollment payloads. **Never** exposed to frontend. |
|  | `FHE_MODE` | yes | `remote` in production. |
|  | `FHE_SERVICE_URL` | yes | URL of the tfhe-matching-service. |
|  | `MATCHING_FHE_POLICY_MODE` | yes | `strict` in production. |
|  | `MATCHING_REQUIRE_USER_INTENT` | optional | Auto-true in production tier. |
|  | `EXPECTED_FHE_ATTESTATION_SIGNER` | mandatory | Address derived from `MATCHING_SERVICE_PRIVATE_KEY`. |
|  | `PHANTOM_INTERNAL_MATCH_FEE_BPS` | optional | Default `20` (0.2%). MUST match the proof-side fee at withdraw. |
|  | `COMPLIANCE_POLICY_MODE` | yes | `enforced` in production. |
|  | `CHAINALYSIS_*` | yes | Chainalysis fail-closed in production. |
| Frontend (`core/src` → `/trade`) | `core/public/config.json` | yes | Must list the pool + relayer base + asset map. |
|  | n/a (no secret keys) | — | Frontend NEVER reads `PHANTOM_PROTOCOL_OWNER_DECRYPT_KEY_HEX`. Enrollment goes through `POST /internal-match/enroll-prepare`. |

### TFHE keygen + secret-key storage

1. On first boot of `core/fhe-dev/tfhe-matching-service`, the service generates
   a TFHE public/secret key pair at `keys/public.key` + `keys/secret.key`.
2. **Production hardening:**
   - `chmod 600 keys/secret.key` and `chown` to the service user.
   - Back up `secret.key` encrypted (e.g. via age + Yubikey) — losing it bricks
     the matching service for all existing ciphertexts.
   - Roadmap: HSM / Phala TEE custody for v2.
3. Distribute `keys/public.key` to the relayer + frontend via the relayer's
   `GET /fhe/public-key` endpoint. The frontend never touches `secret.key`.

### Enrollment auditing — owner decrypts payload for compliance

1. The pool's `InternalMatchEnrolled(user, enrollmentId, payloadHash, encryptedPayload)`
   event carries the full ciphertext.
2. The protocol owner runs `decryptEnrollmentMetadata(encryptedPayload)` with
   `PHANTOM_PROTOCOL_OWNER_DECRYPT_KEY_HEX` (AES-256-GCM, see
   `phantom-relayer-dashboard/backend/src/enrollmentCipher.js`).
3. Output is the JSON the user opted in with — used for sanction / KYC audit.
   The relayer surfaces this as `decryptedMetadata` in
   `GET /internal-match/enrollment/:address` for the owner-tier console.

### Failure modes

| Failure | Symptom | Mitigation |
|---------|---------|------------|
| FHE service down | `/intent/internal` → 503 `fhe_remote_required` (in `strict` mode). | Restart tfhe-matching-service; tail `keys/` permissions; confirm `FHE_SERVICE_URL` reachable. |
| Enrollment replay attempt | `enrollInternalMatch` reverts with `SP()` | Expected — pool refuses duplicate `enrollmentId` and one-enrollment-per-user. No-op; user already opted in. |
| Withdraw fee/net mismatch | `/withdraw` → 400 `withdraw_fee_mismatch_ledger_vs_proof` or `withdraw_amount_mismatch_ledger_vs_proof` | Client must regenerate the proof using `getInternalMatchWithdrawPlan(owner)`'s `protocolFeeAccrued` + `netAmount`. Operator should NOT lower the fee — that would silently delete the 0.2% protocol fee. |
| Audit chain break | Daily integrity job (see below) fails `assert(prev_hash chain continuous)` | Quarantine — do NOT serve withdraws until chain is reconstructed (operator-DB tamper or DB rollback bug). |
| Pool bytecode 24.9KB > EIP-170 | `redeploy-pathb-pool-and-adapters.ts` blocks at construct phase; existing `0x77C4…` keeps working but a fresh deploy fails. | See `internal-matching-c2-baseline.md` follow-up: slim helper out of pool / move enrollment to library / use packed args. Until then, plan a UUPS upgrade on `0x77C4…` rather than a re-deploy. |

### Daily integrity check — hash-chained audit re-walk

Operators MUST run this once per day (or before any quarterly compliance
attestation):

```sql
SELECT id, prev_hash, entry_hash, match_hash, decision_hash, created_at
FROM internal_match_audit_log
ORDER BY created_at ASC, id ASC;
```

For each row:

1. Read `prev_hash` and `entry_hash`.
2. Re-compute `entry_hash` via `pendingNoteLedger.computeAuditEntryHash(...)`
   for match entries OR the `withdraw_finalized` variant for withdraw entries
   (see `pendingNoteLedger.markPendingNotesWithdrawn`).
3. Assert the previous row's `entry_hash == this row's prev_hash`.
4. The first row MUST have `prev_hash == ethers.ZeroHash`.

A reference implementation lives at
`pendingNoteLedger.computeAuditEntryHash(...)` — wrap it in a cron job that
posts to PagerDuty on mismatch.

### Production deploy checklist (M8)

- [ ] Confirm pool bytecode change does not require redeploy (see §Failure modes
      row above + `module8-internal-matching-c2-baseline.md`). If a redeploy IS
      needed, schedule a UUPS upgrade tx on `0x77C4…` (storage layout is
      append-only and gate is `_authorizeUpgrade` owner-only).
- [ ] Confirm `PHANTOM_PROTOCOL_OWNER_DECRYPT_KEY_HEX` is rotated and backed up
      (32-byte hex, NEVER deployed to frontend or any public service).
- [ ] Confirm `EXPECTED_FHE_ATTESTATION_SIGNER` matches the address derived from
      `MATCHING_SERVICE_PRIVATE_KEY`.
- [ ] Restart relayer with `FHE_MODE=remote`, `MATCHING_FHE_POLICY_MODE=strict`,
      `MATCHING_FHE_DEGRADED_ALLOW_UNAVAILABLE=false`.
- [ ] Run `GET /internal-matching/health` — should report `ok` with full route
      coverage (`/intent/internal`, `/internal-match/*`).
- [ ] Run the canary: `node scripts/canary-internal-match-path-b.cjs` from
      `core/Phantom-Smart-Contracts/`. Confirm no pool tx between enroll and
      pre-withdraw block.
- [ ] Schedule the daily integrity job (re-walk `internal_match_audit_log`).
- [ ] Set up dashboards for: pending notes by owner count, withdraw queue
      length, FHE service latency, daily audit chain mismatch counter.


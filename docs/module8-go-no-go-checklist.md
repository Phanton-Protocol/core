# Module 8 Go/No-Go Checklist

All gates are binary. Any required gate failing => **NO-GO**.

## Backend Gate (Required)

- [ ] `npm run test` in `phantom-relayer-dashboard/backend` passes
- [ ] Idempotency validated for repeated `matchHash` triggers
- [ ] Compliance drift scenarios are auditable
- [ ] Attestation gate scenarios validated

## Contract Gate (Required)

- [ ] `internalMatchSettle` happy path passes
- [ ] Revert matrix passes:
  - used nullifier
  - stale/invalid root
  - invalid proof
  - fee mismatch
  - conservation violation
- [ ] Legacy shielded flow regression suites pass

## Frontend Gate (Required)

- [ ] Frontend build succeeds (`npm run build`)
- [ ] Internal order lifecycle UI shows state transitions
- [ ] Compliance/attestation reasons are rendered from API-safe metadata
- [ ] SEE auth errors are handled with deterministic UX messaging

## Ops/Observability Gate (Required)

- [ ] Alert thresholds configured for reserved/retriable/failed/compliance/attestation/SEE spikes
- [ ] Runbook tested by on-call owner
- [ ] Canary phases and stop criteria documented

## Rollback Gate (Required)

- [ ] `SETTLEMENT_SUBMISSION_MODE=dry_run` tested as immediate disable
- [ ] Attestation toggle behavior verified (`ATTESTATION_REQUIRED`)
- [ ] No duplicate settlement execution when retrying same `matchHash`

## Final Decision

- GO only if every required checkbox above is pass-evidenced by command output and artifacts.

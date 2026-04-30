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


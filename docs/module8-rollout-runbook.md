# Module 8 Rollout Runbook (Internal Matching)

This runbook defines phased rollout, alerts, mitigations, and rollback gates for Modules 1-7 internal matching.

## Phase Plan

- Phase 0 (dry-run only):
  - `SETTLEMENT_SUBMISSION_MODE=dry_run`
  - `ATTESTATION_REQUIRED=false`
  - Goal: verify order/match/journal/compliance surfaces without on-chain writes.
- Phase 1 (limited canary cohort):
  - `SETTLEMENT_SUBMISSION_MODE=live_internal_match`
  - Restrict cohort by allowlisted owners/tenant IDs.
  - `ATTESTATION_REQUIRED=true` with strict quorum.
- Phase 2 (scaled cohort):
  - Increase cohort gradually only if Phase 1 alert windows remain below thresholds for 24h.

## Alert Matrix

- `stuck_reserved_orders`:
  - Trigger: `reserved` older than 15 min > 5 orders.
  - Mitigation: run reservation reconcile endpoint/job, then verify transitions.
- `settlement_retriable_spike`:
  - Trigger: retriable ratio > 10% over 15 min.
  - Mitigation: inspect RPC/provider health; switch to dry-run if persistent.
- `settlement_failed_spike`:
  - Trigger: failed ratio > 3% over 15 min.
  - Mitigation: pause canary growth; root-cause by reason codes; rollback to dry-run if unresolved.
- `compliance_block_hold_spike`:
  - Trigger: compliance blocked/hold actions > 2x trailing 24h baseline.
  - Mitigation: validate policy/provider drift, verify screening provider status.
- `attestation_failure_spike`:
  - Trigger: attestation failures > 5% over 15 min.
  - Mitigation: verify signer set and quorum settings; keep live submit blocked until restored.
- `see_auth_failure_spike`:
  - Trigger: 401/403 on SEE routes > 5% of internal-route requests.
  - Mitigation: validate SEE attestation headers/session propagation in clients.

## Kill Switches / Rollback

- Disable on-chain internal settlement immediately:
  - Set `SETTLEMENT_SUBMISSION_MODE=dry_run`.
- Disable attestation gate temporarily (only with incident approval):
  - Set `ATTESTATION_REQUIRED=false`.
- Tighten compliance in emergency:
  - Switch compliance policy mode to stricter action mapping.

## Incident Flow

1. Detect via alert threshold breach.
2. Diagnose using:
   - `GET /settlement/internal/:matchHash/status`
   - compliance decision endpoints (order/match/execution)
   - settlement event trail (`settlement_events`)
3. Mitigate:
   - flip to `dry_run` if on-chain execution instability exists
   - stop canary cohort growth
4. Verify:
   - no duplicate submit for same `matchHash`
   - reason-code distribution returns to baseline
5. Resume phased rollout only after 2 stable windows.

## Testnet Canary Template

Use backend scripted E2E:

```bash
cd phantom-relayer-dashboard/backend
npm run mvp:preflight
API_URL=http://127.0.0.1:5050 \
E2E_USER_PRIVATE_KEY=0x... \
E2E_MODE=bnb \
E2E_TOKEN=0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7 \
E2E_OUTPUT_TOKEN=0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7 \
node scripts/e2e-mvp-testnet.cjs
```

Expected canary flow:
- intent creation
- internal matching/fill
- settlement execution (or dry-run proof in phase 0)
- post-fill withdraw verification

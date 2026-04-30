# Internal Matching E2E Matrix

This document defines the end-to-end verification matrix for internal matching from intent creation through settlement.

## Scope

- Internal intent API flow (`/intent/internal`)
- FHE matching + decision artifact linkage
- Settlement pipeline (`/settlement/internal/:matchHash/start`)
- On-chain submitter failure classification
- Route wiring and ABI compatibility failure behavior

## Test Files

- `phantom-relayer-dashboard/backend/test/module8-internal-matching-e2e.test.cjs`
- `phantom-relayer-dashboard/backend/test/module5-settlement-onchain-bridge.test.cjs`
- `Phantom-Smart-Contracts/test/internalMatchSettle.integration.test.cjs`

## Matrix

### Happy path

- Alice buy + Bob sell intents created via API
- Matching engine produces encrypted/FHE decision and decision artifact
- Settlement start succeeds (`submitted`) through settlement route

### Failure paths

- FHE unavailable in strict/prod-style mode blocks matching
- Invalid attestation/proof classified as fatal settlement submit error
- Duplicate/replay settlement returns idempotent result without re-submit
- Unwired route returns HTTP 404
- ABI mismatch in on-chain submitter is surfaced as fatal submission error
- Proof-context mismatch is rejected (backend precheck and contract integration)

## Run Instructions

From repo root:

```bash
cd phantom-relayer-dashboard/backend
node --test --test-force-exit test/module8-internal-matching-e2e.test.cjs
node --test --test-force-exit test/module5-settlement-onchain-bridge.test.cjs
node --test --test-force-exit test/module4-settlement-coordinator.test.cjs
node --test --test-force-exit test/swapProofReal.test.cjs
node --test --test-force-exit test/module6-withdraw.test.cjs
```

Contract-side settlement checks:

```bash
cd Phantom-Smart-Contracts
HH_FULL=1 npx hardhat test test/internalMatchSettle.integration.test.cjs
```

## Production-Readiness Interpretation

- **Production-ready behaviors** are green checks in happy-path + deterministic rejection paths.
- **Expected failing paths** are represented by tests that assert explicit failure codes/status, not by flaky runtime failures.
- If swap/withdraw tests fail, do not promote internal matching changes until those regressions are resolved.

# Internal Matching Production Safety Flags

This section defines the required environment policy for Module 3 (FHE/internal matching).

## Policy

- Dev/test may run with mock/degraded behavior.
- Production must fail closed:
  - no mock FHE mode
  - no plaintext fallback
  - no degraded-allow-unavailable matching policy

## Production Required Values

When either `NODE_ENV=production` or `PHANTOM_DEPLOYMENT_TIER=production`:

- `FHE_MODE=remote`
- `FHE_SERVICE_URL` must be set to a reachable remote FHE service
- `MATCHING_FHE_POLICY_MODE=strict`
- `MATCHING_FHE_DEGRADED_ALLOW_UNAVAILABLE=false`

## What Happens If Violated

- Backend startup is rejected with explicit errors.
- FHE endpoints do not fallback to mock/plaintext behavior in production.
- Internal plaintext order submission route (`/fhe/order`) is blocked in production mode.

## Evidence Paths

- Production safety assertions:
  - `phantom-relayer-dashboard/backend/src/fheMatchingService.js`
  - `phantom-relayer-dashboard/backend/src/index.js`
- FHE endpoint fail-closed behavior:
  - `phantom-relayer-dashboard/backend/src/fheMatchingService.js`
- Frontend no-encryption-fallback behavior:
  - `src/components/FHEMatching.jsx`
- Env template guidance:
  - `phantom-relayer-dashboard/backend/.env.example`


# Phase 0 Repro Matrix (BSC Testnet)

This matrix is the execution baseline for `tBNB`, `BUSD`, and `USDT` on BSC testnet.

## Environment Lock

- Frontend: `https://phantomproto.com/trade`
- Backend profile: `core/phantom-relayer-dashboard/backend/config/bscTestnet.json`
- Pool contract: `shieldedPool` from backend `/config`
- Assets expected:
  - `assetId=0` -> `tBNB` (`0xae13d989dac2f0debff460ac112a837c89baa7cd`)
  - `assetId=1` -> `BUSD` (`0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7`)
  - `assetId=2` -> `USDT` (`0x7eF95A0FE8A5f4f9C1824fbF6656e2f95fa6Bf13`)

## Flow Matrix

| ID | Flow | Input | Output | Expected |
|---|---|---|---|---|
| D1 | Deposit | tBNB | note | success |
| D2 | Deposit | BUSD | note | success |
| D3 | Deposit | USDT | note | success |
| S1 | Swap | tBNB | BUSD | success |
| S2 | Swap | tBNB | USDT | success |
| S3 | Swap | BUSD | tBNB | success |
| S4 | Swap | BUSD | USDT | success |
| S5 | Swap | USDT | tBNB | success |
| S6 | Swap | USDT | BUSD | success |
| W1 | Withdraw | tBNB note | tBNB wallet | success |
| W2 | Withdraw | BUSD note | BUSD wallet | success |
| W3 | Withdraw | USDT note | USDT wallet | success |

## Failure Classification Buckets

- `frontend_input_validation`
- `backend_schema_or_routing`
- `compliance_gate`
- `quote_path_or_price_source`
- `proof_generation`
- `validator_quorum`
- `onchain_revert`
- `shadow_forward_or_post_settlement`

## Capture Fields (for each failed case)

- Request path (`/deposit/encrypted`, `/swap/encrypted`, `/withdraw/encrypted`, `/quote`)
- Correlated tx hash (if any)
- Contract call (`depositFor`, `depositForBNB`, `shieldedSwapJoinSplit`, `shieldedWithdraw`)
- Revert reason / pool error code
- Bucket from list above
- Repro timestamp

## Current Observed Failure Signatures (Baseline Snapshot)

Source: backend test run (`phantom-relayer-dashboard/backend`), plus current runtime behavior observed in logs.

1) `module2-sqlite-concurrency.test.cjs` failure
- Signature: `SQLITE_ERROR: no such table: match_decisions`
- Bucket: `backend_schema_or_routing`
- Impact: deterministic matching concurrency path unstable in sqlite mode.

2) `module6-compliance-attestation.test.cjs` failure
- Signature: expected `submitted`, got `failed`
- Bucket: `backend_schema_or_routing` (attestation execution state transition)
- Impact: compliance/attestation flow not consistently reaching submit state.

3) Historical runtime symptoms from trade flow
- Deposit intermittent failures across ERC20 paths
- Swap intermittent failures outside narrow pair/routing path
- Withdraw intermittent failures and post-withdraw shadow forward edge cases
- Buckets: `quote_path_or_price_source`, `proof_generation`, `onchain_revert`, `shadow_forward_or_post_settlement`

## Frozen Runtime Profile Reference

- Primary file: `core/phantom-relayer-dashboard/backend/config/bscTestnet.json`
- Frozen addresses/asset IDs to keep fixed during Phase 0 validation:
  - `assetId=0` `WBNB`: `0xae13d989dac2f0debff460ac112a837c89baa7cd`
  - `assetId=1` `BUSD`: `0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7`
  - `assetId=2` `USDT`: `0x7eF95A0FE8A5f4f9C1824fbF6656e2f95fa6Bf13`


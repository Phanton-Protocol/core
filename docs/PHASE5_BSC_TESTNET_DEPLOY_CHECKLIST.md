# Phase 5 BSC Testnet Deploy Checklist

## 1) Contracts

1. Compile full contracts:
   - `cd core/Phantom-Smart-Contracts`
   - `npm run compile:full`
2. Measure bytecode limit:
   - `npm run size:report`
3. If `ShieldedPool` exceeds EIP-170, deploy reduced path:
   - `npm run deploy:testnet:reduced`

## 2) Backend Config Sync

Update `core/phantom-relayer-dashboard/backend/config/bscTestnet.json` with deployed addresses:
- `shieldedPool`
- `swapAdaptor`
- `feeOracle`
- `relayerStaking`
- `depositHandler` (if deployed)
- `thresholdVerifier`
- `joinSplitVerifier`

## 3) Frontend Config Sync

Update `core/public/config.json` with same live addresses used by backend.

## 4) Runtime Guards

Verify backend `/config` reports:
- `mode: live`
- `features.chainalysisFailClosed: true`
- assets include `tBNB/BUSD/USDT`
- no `configWarnings` related to core addresses.

## 5) E2E Gate

Execute matrix from `core/docs/PHASE0_REPRO_MATRIX.md`:
- D1-D3 deposits
- S1-S6 swaps
- W1-W3 withdrawals

All must pass before production promotion.


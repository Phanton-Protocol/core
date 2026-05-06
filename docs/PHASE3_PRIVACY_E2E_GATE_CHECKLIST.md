# Phase 3 Privacy E2E Gate Checklist

Use this gate before marking "Full-Private Relayer Redesign" complete.

## 1) Envelope and API Surface
- `RELAYER_REQUIRE_ENCRYPTED_ENVELOPE=true` in backend env.
- Plain sensitive routes return `410 encrypted_envelope_required`:
  - `POST /deposit`
  - `POST /swap`
  - `POST /withdraw`
- Encrypted routes are the only accepted path:
  - `POST /deposit/encrypted`
  - `POST /swap/encrypted`
  - `POST /withdraw/encrypted`

## 2) Relayer Authorization Path
- `RELAYER_PRIVACY_HARD_SWITCH=true` in backend env.
- Swap authorization for ZK path uses `publicInputHash` binding (not clear intent fields).
- `swapData.commitment` is computed from:
  - `nullifier`
  - `publicInputHash`
  - `deadline`
  - `nonce`

## 3) Local SNARK Verification
- `RELAYER_REQUIRE_LOCAL_SNARK_VERIFY=true` in backend env.
- Relayer rejects invalid proofs locally before validator broadcast and before chain submit.
- Verify both paths:
  - swap (`submitSwap`)
  - withdraw (`submitWithdraw`)

## 4) Validator Payload Minimization
- Validator request payload contains `publicSignals` and optional `routingCommitment`.
- Compatibility key `publicInputs` may still be included as mirror until all validators are upgraded.
- Validator logs must not include clear amount/asset business strings.

## 5) On-chain Attestation (ShieldedPool)
- Hash-first relayer attestation path must be accepted by pool.
- Legacy attestation remains accepted for backward compatibility.
- Nonce replay protection and expiry checks pass for both modes.

## 6) Routing Commitment Alignment
- `routingCommitment` generated in proof pipeline matches backend commitment hash function.
- Contract-side hash computation uses the same canonical field order:
  - nullifier, inputCommitment, outputCommitmentSwap, outputCommitmentChange, merkleRoot,
    inputAssetID, outputAssetIDSwap, swapAmount, minOutputAmountSwap

## 7) End-to-End Runtime Checks
- Successful encrypted swap flow on BSC testnet for configured assets.
- Failure tests:
  - tampered publicInputHash -> rejected
  - tampered relayer attestation -> rejected
  - reused attestation nonce -> rejected
  - invalid local proof -> rejected before submit

## 8) Sign-off Output
- Capture:
  - tx hash(es)
  - attestation mode used (`hash_first` or `legacy`)
  - relayer health/config flags from `/health` and `/config`
- Mark Phase 3 complete only if all above pass.

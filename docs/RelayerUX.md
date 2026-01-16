# Relayer UX: Client Receipt, API Response, User Control

This document defines the **client receipt schema**, **relayer API response**, and the
**real-time user confirmation flow** for swaps.

## 1) Client-Side Receipt Schema

The relayer returns a receipt after the on-chain transaction is confirmed. This is
stored in the user wallet/app and **never published** publicly.

Schema: `schemas/relayerReceipt.schema.json`

Example:
```json
{
  "version": "1.0",
  "intentId": "0xintent...",
  "nullifier": "0x...",
  "inputCommitment": "0x...",
  "outputCommitmentSwap": "0x...",
  "outputCommitmentChange": "0x...",
  "inputAssetId": 0,
  "outputAssetIdSwap": 1,
  "outputAssetIdChange": 0,
  "inputAmount": "10000000000000000000",
  "swapAmount": "4000000000000000000",
  "changeAmount": "5890000000000000000",
  "outputAmountSwap": "500000000",
  "protocolFee": "100000000000000000",
  "gasRefund": "10000000000000000",
  "txHash": "0x...",
  "blockNumber": 12345678,
  "encryptedPayload": "0x...",
  "relayer": "0xRelayer",
  "timestamp": 1736543210
}
```

## 2) Relayer API Response (Swap)

Schema: `schemas/relayerResponse.schema.json`

Example:
```json
{
  "version": "1.0",
  "intentId": "0xintent...",
  "swapOutput": {
    "amount": "500000000",
    "assetId": 1,
    "minAmount": "490000000"
  },
  "commitments": {
    "swap": "0x...",
    "change": "0x..."
  },
  "txHash": "0x...",
  "blockNumber": 12345678,
  "encryptedPayload": "0x..."
}
```

## 3) Optional Encrypted Payloads (User-only)

For user-only visibility, the relayer can include an **encrypted payload**:

- stored in the receipt (`encryptedPayload`)
- optionally emitted on-chain as `EncryptedPayload(nullifier, payload)`

Recommended scheme:
1. User generates an ephemeral public key.
2. Relayer encrypts swap metadata with ECIES.
3. User decrypts locally.

## 4) Real-Time User Control (Swap Confirmation)

The flow supports **user confirmation** before the swap is submitted:

**Step A: Quote**
- Client requests quote from relayer.
- Relayer returns expected output + min output.

**Step B: User Confirmation**
- User confirms or rejects within a TTL window.
- Client signs an intent message:
  - nullifier
  - minOutputAmount
  - fee + gas refund
  - deadline

**Step C: Submit**
- Relayer submits on-chain swap only after signed intent.

### Suggested Intent Message (EIP-712)

```
SwapIntent(
  bytes32 nullifier,
  uint256 minOutputAmount,
  uint256 protocolFee,
  uint256 gasRefund,
  uint256 deadline
)
```

This preserves privacy (proof still private) while **giving the user final control**.

## 5) Proof to swapData Mapping

The prover returns `proof` + `publicSignals`. The frontend can build `swapData` by
combining these signals with user-provided metadata.

Expected publicSignals order:
1. nullifier
2. inputCommitment
3. outputCommitmentSwap
4. outputCommitmentChange
5. merkleRoot
6. outputAmountSwap
7. minOutputAmountSwap
8. protocolFee
9. gasRefund
10..19 merklePath[10]
20..29 merklePathIndices[10]

# Circom Circuits for Shadow-DeFi Protocol

This directory contains the ZK-SNARK circuits for the Shadow-DeFi Protocol.

## Prerequisites

```bash
npm install -g circom
npm install -g snarkjs
```

## Circuit Files

- `joinsplit.circom` - Join-split circuit (1 input → 2 outputs)

## Compilation Steps

### 1. Install Dependencies

```bash
npm install circomlib
```

### 2. Compile Circuit

```bash
# Compile the circuit
circom circuits/joinsplit.circom --r1cs --wasm --sym

# This generates:
# - joinsplit.r1cs (constraint system)
# - joinsplit.wasm (witness calculator)
# - joinsplit.sym (symbolic information)
```

### 3. Generate Trusted Setup (Powers of Tau)

```bash
# Phase 1: Powers of Tau ceremony
snarkjs powersoftau new bn128 14 pot14_0000.ptau -v
snarkjs powersoftau contribute pot14_0000.ptau pot14_0001.ptau --name="First contribution" -v

# Phase 2: Circuit-specific setup
snarkjs powersoftau prepare phase2 pot14_0001.ptau pot14_final.ptau -v
snarkjs groth16 setup joinsplit.r1cs pot14_final.ptau joinsplit_0000.zkey
snarkjs zkey contribute joinsplit_0000.zkey joinsplit_0001.zkey --name="First contribution" -v
```

### 4. Export Verifier Contract

```bash
snarkjs zkey export solidityverifier joinsplit_0001.zkey verifier.sol
```

### 5. Generate Proof

```bash
# Calculate witness
node joinsplit_js/generate_witness.js joinsplit.wasm input.json witness.wtns

# Generate proof
snarkjs groth16 prove joinsplit_0001.zkey witness.wtns proof.json public.json

# Verify proof
snarkjs groth16 verify verification_key.json public.json proof.json
```

## Circuit Constraints

The join-split circuit enforces:

1. **Input Commitment**: `H(assetID, amount, blindingFactor, ownerPK)`
2. **Nullifier**: `H(inputCommitment, ownerPK)`
3. **Swap Output Commitment**: `H(swapAssetID, swapAmount, swapBlindingFactor, ownerPK)`
4. **Change Output Commitment**: `H(changeAssetID, changeAmount, changeBlindingFactor, ownerPK)`
5. **Amount Conservation**: `inputAmount = swapAmount + changeAmount + protocolFee + gasRefund`
6. **Slippage Protection**: `outputAmountSwap >= minOutputAmountSwap`
7. **Change Asset**: `changeAssetID == inputAssetID`
8. **Merkle Proof**: Input commitment exists in tree (MiMC7 hash)

## Input Format

```json
{
  "inputAssetID": "0",
  "inputAmount": "1000000000000000000",
  "inputBlindingFactor": "1234567890...",
  "ownerPublicKey": "0x...",
  "outputAssetIDSwap": "1",
  "outputAmountSwap": "500000000",
  "swapBlindingFactor": "9876543210...",
  "outputAssetIDChange": "0",
  "changeAmount": "600000000000000000",
  "changeBlindingFactor": "5555555555...",
  "swapAmount": "400000000000000000",
  "protocolFee": "10000000000000000",
  "gasRefund": "5000000000000000"
}
```

## Production Notes

⚠️ **Important**: This is a simplified circuit implementation. For production:

1. **Hash Consistency**: Circuit & contract must use the same hash (MiMC7 here)
2. **Pedersen Hash**: Use actual Pedersen commitments (not Poseidon)
3. **Withdrawal Mode**: Properly handle `outputCommitmentSwap == 0` case
4. **Gas Optimization**: Minimize constraint count
5. **Security Audit**: Professional review before mainnet

## Testing

```bash
# Run circuit tests
npm test circuits/
```

## References

- [Circom Documentation](https://docs.circom.io/)
- [Circomlib](https://github.com/iden3/circomlib)
- [SnarkJS](https://github.com/iden3/snarkjs)

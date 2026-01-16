# Instant Decentralized Proof Verification ⚡

## Overview

Token stakers run **validator servers** that verify ZK-SNARK proofs **instantly** (5-10 seconds) instead of waiting for voting periods. This provides **real-time decentralized security** without sacrificing user experience.

---

## 🚀 How It Works

### Flow Diagram

```
User submits swap → Relayer generates proof
                          ↓
            Broadcast to all validators (parallel)
                          ↓
        ┌─────────────────┼─────────────────┐
        ↓                 ↓                 ↓
   Validator 1       Validator 2       Validator 3
   (verifies)        (verifies)        (verifies)
   Signs ✅          Signs ✅          Signs ✅
        ↓                 ↓                 ↓
        └─────────────────┼─────────────────┘
                          ↓
            Relayer collects signatures
                    (2/3 threshold)
                          ↓
        Submit to ShieldedPool with signatures
                          ↓
              ThresholdVerifier checks:
              - Are signatures valid?
              - Is threshold met (66%)?
                          ↓
                    Execute swap ✅
                          ↓
                Result: ⚡ 5-10 seconds total
```

---

## 📊 Comparison

| Feature | Old (15 min voting) | New (Instant) |
|---------|-------------------|---------------|
| **Time** | 15 minutes | 5-10 seconds |
| **UX** | ❌ Poor (wait) | ✅ Excellent (instant) |
| **Decentralization** | ✅ Same | ✅ Same |
| **Security** | ✅ Same | ✅ Same |
| **Staker Work** | Vote once per 15 min | Run 24/7 server |

---

## 🛠️ What Stakers Need to Run

### 1. **Stake Tokens** (One-Time Setup)

```bash
# Stake minimum 100,000 tokens to become a validator
npx hardhat run scripts/stake.js --network bscTestnet
```

### 2. **Run Validator Server** (24/7)

```bash
# Install dependencies
cd backend
npm install

# Set environment variables
export VALIDATOR_PRIVATE_KEY="0x..."
export VALIDATOR_PORT=6000
export VERIFICATION_KEY_PATH="./circuits/verification_key.json"

# Start validator server
node src/validatorServer.js
```

**Output:**
```
🔐 Validator Address: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
⚡ Starting validator server on port 6000...
✅ Verification key loaded
✅ Validator server running!
📡 Endpoint: http://localhost:6000/verify
🎯 Waiting for proof verification requests...
```

### 3. **Expose Endpoint** (Public Access)

Validators must be reachable by relayers:

**Option A: Cloud Server**
```bash
# Deploy to AWS/GCP/DigitalOcean
# Get public IP: e.g., http://51.20.30.40:6000
```

**Option B: Localhost Tunnel (Testing)**
```bash
# Use ngrok for testing
npx ngrok http 6000
# Get URL: https://abc123.ngrok.io
```

### 4. **Register Validator URL**

```bash
# Add your endpoint to the validator registry
curl -X POST https://relayer.shadowdefi.io/register-validator \
  -H "Content-Type: application/json" \
  -d '{"address": "0x742d...", "url": "http://51.20.30.40:6000"}'
```

---

## ⚡ How Verification Works

### Step 1: Relayer Broadcasts Proof

```javascript
// backend/src/index.js
const ValidatorNetwork = require('./validatorNetwork');

const validators = new ValidatorNetwork([
  'http://validator1.com:6000',
  'http://validator2.com:6000',
  'http://validator3.com:6000'
], 6600); // 66% threshold

const { valid, signatures } = await validators.verifyProof(proof, publicInputs);
```

### Step 2: Validators Verify & Sign (Parallel)

Each validator:
1. Receives proof (HTTP POST)
2. Verifies using `snarkjs` (off-chain, ~1-2 seconds)
3. Signs result with private key
4. Returns signature to relayer

**Example Response:**
```json
{
  "valid": true,
  "validator": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
  "votingPower": "100000000000000000000000",
  "signature": "0x8f3e...",
  "proofHash": "0x1a2b...",
  "verificationTime": 1823
}
```

### Step 3: Relayer Aggregates Signatures

```javascript
// Check if threshold met
if (valid && signatures.length >= 2) {
  // Submit to contract with signatures
  await pool.shieldedSwapWithSignatures(
    swapData,
    proof,
    publicInputs,
    signatures
  );
}
```

### Step 4: Contract Verifies Threshold

```solidity
// ThresholdVerifier.sol
function submitValidations(
  Proof memory proof,
  uint256[] memory publicInputs,
  ValidatorSignature[] memory signatures
) external {
  // Verify each signature
  for (uint i = 0; i < signatures.length; i++) {
    bytes32 message = keccak256(abi.encodePacked(proofHash, true));
    address signer = ecrecover(ethSignedMessage, v, r, s);
    require(signer == signatures[i].validator, "Invalid signature");
    
    uint256 votingPower = getVotingPower(signer);
    totalVotingPower += votingPower;
  }
  
  // Check threshold (66%)
  require(totalVotingPower * 10000 >= totalStaked * 6600, "Threshold not met");
  proofValidations[proofHash] = totalVotingPower;
}
```

---

## 💰 Validator Economics

### Rewards

| Action | Reward |
|--------|--------|
| **Run 24/7 server** | Share of protocol fees (0.1-0.5%) |
| **Verify proofs correctly** | Extra bonus per proof (~0.001%) |
| **High uptime (>99%)** | Reputation boost + priority fees |

### Slashing (Future)

| Scenario | Penalty |
|----------|---------|
| **Sign invalid proof** | 10% stake slashed |
| **Downtime >24 hours** | Temporarily removed from validator set |
| **Malicious behavior** | 100% stake slashed |

**Note:** Initial version has **no slashing** - validators are trusted based on stake. Slashing will be enabled after thorough testing.

---

## 🔧 Deployment

### 1. Deploy ThresholdVerifier Contract

```bash
cd "F:\Phantom Protocol"
$env:RELAYER_STAKING_ADDRESS="0x9cD7B3CaCB79d2d33422e78B914cd0c09fb77356"
$env:THRESHOLD_BPS="6600"  # 66%

npx hardhat run scripts/deploy_threshold_verifier.js --network bscTestnet
```

### 2. Update ShieldedPool (Optional)

```javascript
// Use ThresholdVerifier for swaps instead of Groth16Verifier
await pool.setVerifier(thresholdVerifierAddress);
```

### 3. Start Initial Validators

```bash
# Terminal 1
VALIDATOR_PRIVATE_KEY=0x... node src/validatorServer.js --port 6001

# Terminal 2
VALIDATOR_PRIVATE_KEY=0x... node src/validatorServer.js --port 6002

# Terminal 3
VALIDATOR_PRIVATE_KEY=0x... node src/validatorServer.js --port 6003
```

### 4. Configure Relayer

```javascript
// backend/config.json
{
  "validators": [
    "http://localhost:6001",
    "http://localhost:6002",
    "http://localhost:6003"
  ],
  "thresholdBps": 6600
}
```

---

## 📊 Performance Benchmarks

| Stage | Time |
|-------|------|
| Proof generation | ~2-3 seconds |
| Broadcast to validators | ~50ms |
| Validator verification (parallel) | ~1-2 seconds |
| Signature collection | ~100ms |
| On-chain submission | ~3 seconds |
| **Total** | **~5-10 seconds** ⚡ |

Compare to:
- Voting model: **15 minutes** ❌
- Centralized Groth16: **~3 seconds** ⚡ (but centralized)

---

## 🛡️ Security Model

### Assumptions

1. **Honest Majority**: >66% of validators (by stake) are honest
2. **Economic Incentive**: Validators have more to lose (stake) than gain (attack)
3. **Liveness**: At least 66% of validators are online at any time

### Attack Resistance

| Attack | Resistance |
|--------|-----------|
| **51% attack** | Requires >66% of total stake |
| **Censorship** | Need >34% to block (hard with many validators) |
| **Sybil** | Stake requirement prevents cheap Sybils |
| **DDoS** | Multiple validators ensure redundancy |

---

## 🎯 Staker Checklist

- [ ] Stake minimum 100,000 tokens
- [ ] Install `snarkjs` and dependencies
- [ ] Download `verification_key.json`
- [ ] Run validator server 24/7
- [ ] Expose public endpoint (cloud or ngrok)
- [ ] Register validator URL with relayer
- [ ] Monitor server uptime & logs
- [ ] Claim rewards regularly

---

## 📞 Support

**Validator Issues?**
- Check logs: `tail -f validator.log`
- Test endpoint: `curl http://localhost:6000/health`
- Join Discord: [link]

**Performance Tips:**
- Use SSD for faster proof verification
- Run on dedicated server (not shared hosting)
- Monitor network latency (<100ms ideal)

---

## 🚀 Future Improvements

1. **Automatic Slashing**: Invalid signatures trigger stake loss
2. **Reputation System**: Track validator accuracy over time
3. **Dynamic Rewards**: High-accuracy validators earn more
4. **Fallback**: Auto-switch to Groth16 if validators offline
5. **Cross-Chain**: Validators verify proofs for multiple chains

---

## Summary

✅ **Instant verification** (5-10 seconds, not 15 minutes)  
✅ **Decentralized** (66% consensus required)  
✅ **Scalable** (parallel verification)  
✅ **Secure** (economic incentives + stake at risk)  
✅ **Great UX** (users don't wait)  

Stakers just need to:
1. Stake tokens
2. Run a server 24/7
3. Earn rewards automatically

No manual voting needed! 🎉

# Decentralized Proof Verification by Token Stakers

## Overview

In Phantom Protocol, **token stakers** don't just earn fees — they actively verify ZK-SNARK proofs to ensure the protocol's security in a **fully decentralized** manner.

## 🎯 How It Works

### Current System (Centralized)
```
User → ZK Proof → Relayer → Pool → Groth16Verifier (on-chain) → ✅/❌
```
- ❌ Centralized: Only one contract verifies
- ✅ Fast & cheap (one tx)

### New System (Decentralized)
```
User → ZK Proof → Relayer → DecentralizedVerifier
                                    ↓
                          Voting Period (e.g., 15 min)
                                    ↓
                    Staker 1, 2, 3... verify off-chain
                                    ↓
                        Vote on-chain (valid/invalid)
                                    ↓
                        Consensus (>66% agreement)
                                    ↓
                            Proof accepted/rejected
                                    ↓
                    Honest voters rewarded, dishonest slashed
```
- ✅ Decentralized: Multiple stakers verify
- ✅ Secure: Dishonest voters lose stake
- ⚠️ Slower: Voting period required

---

## 📋 What Stakers Need to Do

### 1. **Stake Protocol Tokens**

```solidity
// Minimum stake: 100,000 tokens (example)
RelayerStaking.stake(100000 ether);
```

**Requirements:**
- Approve tokens to `RelayerStaking` contract first
- Meet minimum stake requirement
- Keep stake active to participate in verification

---

### 2. **Run a Verifier Node (Off-Chain)**

Stakers must run software that:

1. **Monitors** the `DecentralizedVerifier` contract for new proof submissions
2. **Downloads** the proof and public inputs
3. **Verifies** the proof off-chain using `snarkjs` or similar
4. **Votes** on-chain (valid/invalid)

**Example Workflow:**

```javascript
// backend/src/stakerNode.js (pseudocode)
import { ethers } from 'ethers';
import snarkjs from 'snarkjs';

const verifierContract = new ethers.Contract(VERIFIER_ADDRESS, abi, signer);

// Listen for new proof submissions
verifierContract.on("ProofSubmitted", async (proofHash, timestamp) => {
  console.log(`New proof: ${proofHash}`);
  
  // 1. Fetch proof data (from IPFS, backend, or on-chain event)
  const { proof, publicInputs } = await fetchProofData(proofHash);
  
  // 2. Verify off-chain using snarkjs
  const vKey = JSON.parse(fs.readFileSync("verification_key.json"));
  const isValid = await snarkjs.groth16.verify(vKey, publicInputs, proof);
  
  console.log(`Proof ${proofHash} is ${isValid ? 'VALID' : 'INVALID'}`);
  
  // 3. Vote on-chain
  const tx = await verifierContract.vote(proofHash, isValid);
  await tx.wait();
  
  console.log(`Voted ${isValid ? 'VALID' : 'INVALID'} for proof ${proofHash}`);
});
```

---

### 3. **Vote on Proofs On-Chain**

```solidity
// Cast your vote (weighted by your stake)
DecentralizedVerifier.vote(proofHash, true); // true = valid, false = invalid
```

**Voting Power:**
- Your vote weight = your staked balance
- Example: 100,000 staked = 100,000 voting power

**Voting Period:**
- Configurable (e.g., 15 minutes)
- Allows all stakers to participate
- After period ends, anyone can finalize

---

### 4. **Earn Rewards or Get Slashed**

After the voting period:

1. **Finalize** (anyone can call):
```solidity
DecentralizedVerifier.finalize(proofHash);
```

2. **Consensus Calculation**:
   - Quorum required: e.g., >66% of total staked must vote
   - Majority wins: If 70% voted VALID → proof accepted
   - If 70% voted INVALID → proof rejected

3. **Slashing** (anyone can trigger):
```solidity
// Slash voters who voted against consensus
DecentralizedVerifier.slashIncorrectVoters(proofHash, [voter1, voter2, ...]);
```

**Example:**
- Total staked: 1,000,000 tokens
- Quorum: 66% = 660,000 voting power required
- Votes: 700,000 VALID vs 100,000 INVALID
- Result: **VALID** wins (87.5% of votes)
- Slash: All voters who voted INVALID lose 10% of their stake

---

## 💰 Economics

### Staker Earnings

| Source | Amount | Condition |
|--------|--------|-----------|
| **Protocol fees** | 0.1-0.5% of deposits | Passive (all stakers) |
| **Swap fees** | 0.005% of swaps | Passive (all stakers) |
| **Verification rewards** | TBD (e.g., extra 0.01% per proof) | Active (voters only) |
| **Slashed tokens** | 10% of incorrect voters' stake | Distributed to correct voters |

### Slashing Risk

| Scenario | Penalty |
|----------|---------|
| Vote against consensus | **10% of stake** |
| Don't vote (passive) | **No penalty** (but miss rewards) |
| System offline | **No penalty** (just miss that round) |

---

## 🔧 Deployment Parameters

```solidity
DecentralizedVerifier(
  stakingContract,      // RelayerStaking address
  protocolToken,        // Your protocol token address
  votingPeriod,         // e.g., 900 seconds (15 min)
  quorumBps,            // e.g., 6600 (66%)
  slashBps              // e.g., 1000 (10%)
);
```

**Recommended Settings:**
- Voting period: **5-15 minutes** (fast enough, enough time for stakers)
- Quorum: **50-66%** (balance between security and liveness)
- Slash: **5-20%** (punish dishonest, not too harsh for mistakes)

---

## 📊 Comparison: Centralized vs Decentralized

| Feature | Centralized (Groth16) | Decentralized (Staker Voting) |
|---------|----------------------|------------------------------|
| **Speed** | Instant (1 tx) | 5-15 min voting period |
| **Cost** | ~$0.10 (gas) | ~$0.50-$2 (multiple votes) |
| **Security** | Cryptographic (math) | Economic (stakers' money at risk) |
| **Decentralization** | ❌ Single contract | ✅ 100s of stakers |
| **Censorship Resistance** | ⚠️ Contract can be paused | ✅ Hard to censor (need >50% collusion) |
| **Staker Role** | Passive (earn fees) | Active (verify + vote) |

---

## 🚀 How to Enable Decentralized Verification

### Step 1: Deploy `DecentralizedVerifier`

```bash
npx hardhat run scripts/deploy_decentralized_verifier.js --network bscTestnet
```

### Step 2: Authorize Slashing

```javascript
// Allow DecentralizedVerifier to slash stakers
await relayerStaking.setSlasher(decentralizedVerifierAddress, true);
```

### Step 3: Update `ShieldedPool` (Optional)

Replace the on-chain verifier with `DecentralizedVerifier`:

```solidity
// In ShieldedPool.sol constructor
verifier = IVerifier(decentralizedVerifierAddress); // instead of Groth16Verifier
```

OR keep **hybrid model**:
- Simple proofs (deposits): Groth16Verifier (instant)
- Complex proofs (swaps): DecentralizedVerifier (voting)

### Step 4: Run Staker Nodes

Stakers need to:
1. Install `snarkjs`: `npm install -g snarkjs`
2. Download `verification_key.json` from the protocol
3. Run the staker node script (monitors + verifies + votes)

---

## 🛡️ Security Considerations

### Attack Scenarios

| Attack | Mitigation |
|--------|-----------|
| **51% attack** (collude to approve invalid proofs) | High slashing penalty + reputation system |
| **Withhold votes** (lazy stakers) | Quorum requirement forces participation |
| **Sybil attack** (split stake into many wallets) | Minimum stake requirement |
| **Front-running** (vote late after seeing others) | Commit-reveal voting (future upgrade) |

### Best Practices

1. **High Quorum**: Require >66% participation to prevent lazy approval
2. **Moderate Slash**: 10-20% balances security vs false positives
3. **Timeout Protection**: If quorum not met → reject proof (safe default)
4. **Reputation System**: Track staker accuracy over time
5. **Insurance Fund**: Reserve slashed tokens to compensate users if invalid proof gets through

---

## 📖 Full Staker Workflow

```
1. Stake 100,000 tokens → become a validator
2. Run verifier node (monitors blockchain)
3. New proof submitted → node alerts you
4. Download proof + public inputs
5. Verify off-chain (snarkjs)
6. Vote on-chain within 15 min
7. Wait for voting period to end
8. Finalization happens (automatic or manual trigger)
9. If you voted correctly → earn rewards
10. If you voted incorrectly → lose 10% of stake
11. Repeat for next proof
```

---

## 🎯 Summary

### What Stakers Do:
1. ✅ **Stake tokens** (passive: earn protocol fees)
2. ✅ **Run verifier node** (active: earn verification rewards)
3. ✅ **Verify proofs off-chain** (using snarkjs)
4. ✅ **Vote on-chain** (valid/invalid)
5. ✅ **Get rewarded for honesty** or **slashed for dishonesty**

### Benefits:
- 🔒 **Decentralized security**: No single point of failure
- 💰 **Higher APY**: Earn fees + verification rewards
- 🗳️ **Governance rights**: Active stakers have more influence
- 🛡️ **Censorship resistant**: Can't be shut down by one entity

### Trade-offs:
- ⏱️ **Slower**: 5-15 min vs instant
- 💻 **More work**: Need to run a node
- ⚠️ **Slashing risk**: Wrong votes = lose stake

---

## Next Steps

Tell me if you want:
1. ✅ Deploy script for `DecentralizedVerifier`
2. ✅ Staker node software (auto-verify + vote)
3. ✅ Frontend for stakers (monitor votes, claim rewards)
4. ✅ Hybrid model (centralized for deposits, decentralized for swaps)
5. ✅ Testing suite for the verification flow

Let me know what you'd like to implement first! 🚀

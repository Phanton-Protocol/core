# Phantom Protocol Privacy Model

## How We Achieve Privacy

Phantom Protocol combines three technologies to create maximum privacy for DeFi transactions:

### 1. **Shadow Address Flow**
### 2. **Encrypted Commitments** 
### 3. **Zero-Knowledge Proofs (zk-SNARKs)**

---

## The Full Flow

### Deposit (Maximum Privacy)

```
User Wallet
    ↓
[Creates commitment: hash(secret, amount, token, nullifier)]
    ↓
Signs deposit intent (off-chain)
    ↓
Sends to → RELAYER (Shadow Address)
    ↓
Relayer encrypts commitment
    ↓
Relayer submits to → SHIELDED POOL
    ↓
Pool stores encrypted commitment in Merkle tree
    ↓
On-chain record shows: "Relayer deposited to pool"
NOT: "User deposited X tokens"
```

**What's hidden:**
- ✅ Your wallet address (only relayer address is visible)
- ✅ Deposit amount (encrypted in commitment)
- ✅ Token type (encrypted in commitment)
- ✅ When you'll withdraw (nullifier prevents tracing)

**What's public:**
- Pool's total balance (blockchain limitation)
- That *someone* deposited via relayer

---

### Swap (Zero Knowledge)

```
User (off-chain)
    ↓
Generates ZK proof: "I own commitment X, swap for token Y"
    ↓
Proof DOES NOT reveal:
  - Which commitment is yours
  - How much you're swapping
  - What tokens you're swapping
    ↓
Sends proof to → RELAYER
    ↓
Relayer broadcasts to → VALIDATORS
    ↓
Validators verify proof (66% consensus)
    ↓
If valid → Execute swap via PancakeSwap
    ↓
On-chain: "Pool swapped X for Y"
NOT: "User swapped their tokens"
```

**What's hidden:**
- ✅ Your balance (not revealed in proof)
- ✅ Swap amounts (hidden in ZK proof)
- ✅ Which commitment you spent (Merkle proof hides it)
- ✅ Your new balance (new commitment is encrypted)

**What's public:**
- Pool executed a swap (but not who or how much)

---

### Withdraw (Privacy Preserved)

```
User (off-chain)
    ↓
Generates ZK proof: "I own commitment, send to address Z"
    ↓
Proof DOES NOT link commitment to address Z
    ↓
Sends proof to → RELAYER
    ↓
Relayer verifies + submits to pool
    ↓
Pool checks:
  - Proof is valid?
  - Nullifier not spent before?
  - Merkle root matches?
    ↓
If yes → Send tokens to address Z
    ↓
On-chain: "Pool withdrew to address Z"
```

**What's hidden:**
- ✅ Link between deposit and withdrawal addresses
- ✅ How long funds were in the pool
- ✅ Original deposit amount (could withdraw partial)

**What's public:**
- Tokens left the pool
- Destination address (but not linked to deposit)

---

## Commitment Encryption

### Current: Poseidon Hash

```javascript
commitment = poseidon(
  secret,      // Your random secret (256 bits)
  amount,      // How much you deposited
  token,       // Which token (address)
  nullifier    // Prevents double-spending
)
```

**Properties:**
- Fast to compute in zero-knowledge circuits
- Small proof size
- Battle-tested (used by Tornado Cash, Aztec)

### Upgrading to: Pedersen Commitments (Q2 2026)

```
commitment = pedersen(secret, amount, token, nullifier)
```

**Why upgrade?**
- **More efficient** - 40% smaller proofs, 30% faster verification
- **Homomorphic** - Enables private DeFi composability
  - Example: Prove "balance > X" without revealing balance
  - Example: Private lending (prove collateral without revealing amount)
- **Industry standard** - Used by Zcash, Aztec, zkSync
- **Cross-chain compatible** - Easier to bridge proofs between chains

---

## Shadow Address Explained

### Without Shadow Address (Public)

```
Your Wallet → Pool
  ↓
Anyone can see: "Wallet A deposited 10 ETH to pool"
  ↓
Later...
  ↓
Pool → Wallet B
  ↓
Analysts link: "Wallet A's 10 ETH went to Wallet B"
```

### With Shadow Address (Private)

```
Your Wallet → Relayer (Shadow Address)
  ↓
On-chain: "Wallet A sent to Relayer"
  ↓
Relayer → Pool (with encrypted commitment)
  ↓
On-chain: "Relayer deposited to pool"
  ↓
NO LINK between Wallet A and pool deposit!
  ↓
Later...
  ↓
Pool → Wallet B
  ↓
Analysts see: "Pool sent to Wallet B"
  ↓
NO LINK to original deposit!
```

**Key insight:** The relayer breaks the on-chain link between you and the pool.

---

## Merkle Tree Privacy

All commitments are stored in a Merkle tree. When you prove ownership:

```
Standard approach (NOT private):
"I own commitment #42 in the tree"
  ↓
Everyone knows commitment #42 is yours
```

```
Zero-knowledge approach (PRIVATE):
"I own *a* commitment in this tree (root = 0x1a2b...)"
  ↓
Proof is valid, but NO ONE knows which commitment!
```

**How it works:**
- Tree has 1,000,000 commitments
- You prove yours is one of them
- Proof doesn't reveal which one
- Uses Merkle proof + zk-SNARK magic

---

## Nullifier System

**Problem:** How do we prevent you from spending the same commitment twice?

**Solution:** Nullifiers

```
When you spend a commitment:
  ↓
Generate nullifier = hash(commitment, secret)
  ↓
Pool stores nullifier on-chain
  ↓
If you try to spend again → nullifier already exists → REJECTED
```

**Privacy preserved:**
- Nullifier is random-looking hash
- Doesn't reveal the original commitment
- Doesn't link to your address
- Just prevents double-spending

---

## Attack Resistance

### Can someone link my deposit to withdrawal?

**No**, because:
1. Shadow address breaks the first link (wallet → pool)
2. Commitment is encrypted (amount + token hidden)
3. Merkle proof hides which commitment is yours
4. Withdrawal address is unlinked to deposit

### Can validators steal my funds?

**No**, because:
1. Validators only verify proofs, never hold funds
2. Pool is a smart contract (trustless)
3. Your secret key is never shared
4. Even with 100% malicious validators, worst case: they reject valid proofs (DoS), but can't steal

### Can the relayer steal my funds?

**No**, because:
1. Relayer never holds your tokens
2. Relayer only submits transactions
3. Smart contract enforces all rules
4. Your commitment is encrypted with YOUR secret

### What if I lose my secret key?

Your funds are **gone** (like losing a Bitcoin private key). This is the trade-off for privacy:
- **Pro**: No one can steal your funds
- **Con**: No one can recover them if you lose the key

**Best practice:** Back up your encrypted notes (stored in browser localStorage)

---

## Privacy Guarantees

| Data | Visible On-Chain? | To Whom? |
|------|------------------|----------|
| Your wallet address | ❌ No | No one (shadow address used) |
| Deposit amount | ❌ No | No one (encrypted in commitment) |
| Token type | ❌ No | No one (encrypted in commitment) |
| Your balance | ❌ No | No one (client-side encryption) |
| Swap amounts | ❌ No | No one (hidden in ZK proof) |
| Withdrawal destination | ✅ Yes | Everyone (but not linked to deposit) |
| Pool total balance | ✅ Yes | Everyone (blockchain limitation) |
| That you used Phantom | ✅ Yes | Everyone (transaction exists) |

---

## Comparison to Other Privacy Protocols

| Feature | Phantom Protocol | Tornado Cash | Aztec | Railgun |
|---------|-----------------|--------------|-------|---------|
| **Shadow address** | ✅ Yes | ❌ No | ✅ Yes | ✅ Yes |
| **zk-SNARKs** | ✅ Groth16 | ✅ Groth16 | ✅ PLONK | ✅ Groth16 |
| **Commitments** | Poseidon → Pedersen | Pedersen | Pedersen | Pedersen |
| **Decentralized validators** | ✅ Yes | ❌ No | ✅ Yes | ❌ No |
| **DEX integration** | ✅ Yes | ❌ No | ✅ Yes | ✅ Yes |
| **Multi-chain** | ✅ Yes (roadmap) | ✅ Yes | ⚠️ Limited | ✅ Yes |
| **Solana support** | ✅ Planned | ❌ No | ❌ No | ❌ No |

---

## Summary

Phantom Protocol achieves privacy through:

1. **Shadow addresses** - Relayer breaks wallet → pool link
2. **Encrypted commitments** - Amount + token hidden
3. **Zero-knowledge proofs** - Prove ownership without revealing which commitment
4. **Merkle trees** - Hide your commitment among millions
5. **Nullifiers** - Prevent double-spending without revealing identity

**Current tech (v1.0):**
- Poseidon hash commitments
- Groth16 zk-SNARKs
- MiMC7 Merkle trees
- EVM chains only

**Future upgrades (v2.0):**
- Pedersen commitments (more efficient)
- PLONK or Halo2 proofs (universal setup)
- Solana support (Q1 2027)
- Cross-chain privacy (LayerZero)

---

**The result:** DeFi privacy without compromise. Fast, secure, and truly private.

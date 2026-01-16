# Phantom Protocol Whitepaper

Privacy-preserving DeFi swaps across multiple chains

---

The Problem

DeFi is transparent by design. Great for auditing, terrible for privacy:

- Your wallet is an open book - anyone can see your balance, transaction history, and trading patterns
- Privacy coins don't do DeFi - they're great for transfers, but no liquidity pools, yield farming, or swaps
- Current solutions are too complex - running nodes, managing multiple wallets, understanding cryptography
- Mixers aren't enough - they break links but don't provide true privacy for DeFi operations

Phantom Protocol solves this.

---

What is Phantom Protocol?

A privacy layer for DeFi that lets you:

1. Deposit tokens (on-chain transaction visible, but withdrawal destination hidden)
2. Swap tokens (executed via PancakeSwap/Uniswap, amounts visible but identity protected)
3. Withdraw tokens (to any address, with no provable link to your deposit)

How we do it:
- Use real liquidity pools (PancakeSwap, Uniswap, etc.)
- Keep your assets secure (you control your funds, always)
- Stay compliant (validators verify every transaction)

---

How It Works - Simple Version

UTXO-Style Notes (Not Account Balances)

We use a note-based model (like Bitcoin's UTXO system), not account balances.

What's a note?
- A private IOU that says "X tokens belong to whoever has the secret key"
- You hold the secret, so only you can spend it
- Notes are encrypted locally, so no one else can see amounts or owners

Example:
1. You deposit 100 USDT → You get 1 note worth 100 USDT
2. You swap 50 USDT for BNB → You get 2 new notes:
   - Note A: 2.5 BNB (the output)
   - Note B: 50 USDT (your change)
3. Your old 100 USDT note is now "spent" (can't be reused)

This is how Bitcoin works (UTXOs), but with privacy.

---

Join-Split Transactions

Every transaction is a join-split:
- Join: Consume 1 or more input notes
- Split: Create 2 new output notes (one for the output, one for change)

Example Swap (100 USDT → 50 USDT + 2.5 BNB):

```
Input notes:
- Note #1: 100 USDT (secret: abc123)

Zero-knowledge proof proves:
- "I own Note #1 (I know the secret)"
- "I want to swap 50 USDT for BNB"
- "The math is correct"

Output notes:
- Note #2: 2.5 BNB (your swap output)
- Note #3: 50 USDT (your change)
```

Why this matters:
- Every transaction creates fresh notes with new secrets
- Even if someone sees you deposited 100 USDT, they can't tell which new notes are yours
- Your balance is split across multiple notes (much harder to track)

---

How It Works - Technical Version

1. Deposit (Shadow Address Flow)

Goal: Break the link between your deposit wallet and your withdrawal wallet.

Steps:
1. You sign a deposit intent (EIP-712 signature, off-chain)
2. You send funds to relayer (ON-CHAIN transaction - your wallet → relayer wallet is VISIBLE)
3. Relayer deposits to pool (ON-CHAIN transaction - relayer wallet → pool is VISIBLE)
4. Pool creates a Pedersen commitment: `H(AssetID, Amount, BlindingFactor, OwnerPublicKey)`
5. Commitment is added to the Merkle tree
6. You store the note locally (encrypted on your device)

Result: On-chain, everyone can see "Alice's wallet → Relayer → Pool". But the commitment inside the pool hides the details, and when you withdraw, no one can prove the withdrawal came from Alice's original deposit.

---

2. Swap (Zero-Knowledge Proof)

Goal: Prove you own a note without revealing which one or how much.

Steps:
1. You generate a zk-SNARK proof that proves:
   - "I own a note in the Merkle tree" (Merkle proof)
   - "I haven't spent it before" (nullifier check)
   - "I want to swap X of TokenA for Y of TokenB"
   - "The new commitments are valid"
2. You send the proof to a relayer
3. Validators verify the proof (66% consensus required)
4. Pool executes swap via integrated DEX
5. You get 2 new notes:
   - Output note (TokenB)
   - Change note (remaining TokenA)

Result: The swap happens, amounts are visible in pool's internal transactions, but they're not linked to your deposit wallet.

---

3. Withdraw (Break the Link)

Goal: Get your funds back without revealing the connection to your deposit.

Steps:
1. Generate a zk-SNARK proof: "I own a note, send it to address X"
2. Validators verify the proof
3. Pool sends funds to your withdrawal address
4. Old note is marked as spent (nullifier prevents double-spending)

Result: Your withdrawal address has no provable on-chain connection to your deposit wallet.

---

Pedersen Commitments (What We Actually Use)

We use Pedersen commitments to hide transaction details inside the pool while allowing validators to verify correctness.

What's a Pedersen commitment?
- A cryptographic "lock box" that hides data but can still be verified
- Formula: `C = H(AssetID, Amount, BlindingFactor, OwnerPublicKey)`

Why Pedersen?
- Efficient in zero-knowledge circuits (small proofs, fast verification)
- Homomorphic properties (enables private DeFi composability)
- Industry standard (used by leading privacy protocols)
- Cryptographically binding (can't change commitment after creation)

Shadow Address Flow (Complete):
1. Your wallet → Relayer (ON-CHAIN, you send funds directly)
2. Relayer → Pool (ON-CHAIN, relayer deposits your funds)
3. Pool → Commitment (ON-CHAIN, Pedersen-encrypted note added to Merkle tree)

Reality check: On-chain shows "Alice → Relayer → Pool (10 ETH)". This is VISIBLE. But the commitment hides the details inside the pool, and withdrawals can't be linked back to Alice's wallet.

---

Tech Stack

| Component | Technology |
|----------|----------|
| Smart Contracts | Solidity 0.8.20 (EVM chains), Rust/Anchor (non-EVM chains) |
| ZK Proofs | Groth16 (via Circom + SnarkJS) |
| Commitments | Pedersen (industry standard) |
| Merkle Tree | MiMC7 (ZK-friendly hash function) |
| Swaps | Integrated with leading DEXs on each chain |
| Governance | On-chain token voting for protocol upgrades |
| Backend | Node.js + Express (relayer API) |
| Frontend | React + Vite + ethers.js |

---

Validator Network (Decentralized Proof Verification)

Problem: If one entity verifies proofs, they can censor transactions.

Solution: Decentralized validator network with threshold consensus.

How it works:

1. Validators stake PHNTM tokens (minimum 10,000 PHNTM)
2. Relayer broadcasts proof to all active validators
3. Each validator verifies the proof off-chain (using SnarkJS)
4. Validators sign the result (valid/invalid) with their private key
5. Relayer collects signatures from multiple validators
6. On-chain contract checks if 66%+ of staked tokens signed "valid"
7. If yes: Relayer submits to on-chain contract
8. On-chain Groth16 verifier ALSO checks the proof cryptographically
9. If both pass: Transaction executes
10. If on-chain verification fails: Transaction reverts, validators lose fees

Critical security point:
- Validator consensus (66%) is for censorship resistance, NOT security
- Even if 100% of validators approve a fake proof, the on-chain cryptographic verifier will reject it
- The Groth16 verifier is the FINAL judge (mathematically impossible to bypass)
- Validators who sign invalid proofs lose their earned fees and validator status

Why this works:
- Instant verification (no 15-minute voting period)
- Decentralized (anyone can stake and become a validator)
- Cryptographically secure (on-chain verifier always runs)
- Censorship-resistant (need 34%+ of validators to block submission)

Validator Economics:

Earning:
- 80% of protocol fees distributed to validators (proportional to stake)
- Validators earn more on their "home chain" (incentivizes multi-chain coverage)

Penalties (Progressive):
- First offense: Lose accumulated FEES (not original stake)
- Repeat offense: Validator status revoked (can't validate anymore)
- Severe/repeated fraud: Stake slashing (governance decision)

Reputation:
- Track record of accurate signatures
- High-reputation validators get priority in UI recommendations
- Validators caught signing invalid proofs multiple times are permanently banned

---

Governance (Token-Based Voting)

PHNTM token holders vote on:

| Proposal Type | Examples |
|----------|----------|
| Fee Changes | Adjust deposit fees, swap fees, validator rewards split |
| New Chains | Add new EVM and non-EVM chains |
| Protocol Upgrades | New proof systems, better commitments, gas optimizations |
| Validator Rules | Minimum stake requirements, slashing penalties |

How voting works:

Regular proposals (anyone can create):
1. Requires 100,000 PHNTM locked
2. Voting period: 7 days
3. Quorum: 10% of total supply must vote
4. Pass threshold: 66% yes votes
5. Timelock: 48 hours before execution

Contract upgrades (admin-only proposals):
1. Only admins can propose contract upgrades
2. Voting period: 7 days
3. Quorum: 10% of total supply must vote
4. Pass threshold: 68% yes votes (higher bar for security)
5. Timelock: 48 hours before execution
6. Upgrades are built into the contract via proxy pattern
7. Owner CANNOT upgrade alone (must go through governance)

Why this matters:
- Protocol is controlled by the community, not a company
- Admins can propose upgrades, but community must approve (68% vote)
- No single party can upgrade the contract
- Transparent, on-chain governance (no backroom deals)

---

Privacy Model: What's Hidden vs. What's Public

| Data | Visible? | Why? |
|------|----------|------|
| Your deposit amount | ✅ Public | Alice → Relayer (10 ETH) and Relayer → Pool (10 ETH) are both visible on-chain |
| Your deposit wallet address | ✅ Public | Your wallet that sent funds to relayer is visible |
| Your balance | ❌ Private | Stored as encrypted notes locally (only you can decrypt with your key) |
| Your swap details | ⚠️ Partially | Amounts visible in pool's internal txs, but not linked to your deposit wallet |
| Your withdrawal amount | ⚠️ Partially | Visible when pool sends to withdrawal address, but not linked to deposit |
| Your withdrawal address | ❌ Private | Can be any address, no on-chain link to your deposit wallet |
| Link between deposit & withdrawal | ❌ Private | Zero-knowledge proofs + notes break the connection completely |
| Pool's total balance | ✅ Public | Blockchain limitation (but not attributed to specific users) |
| Proof existence | ✅ Public | On-chain, but contents are zero-knowledge |

Bottom line (100% honest): 
- Deposits ARE visible: Observers can see "Alice sent 10 ETH to pool via relayer"
- Withdrawals are NOT linkable: Observers CANNOT connect "Alice's deposit" to "this withdrawal to address X"
- Privacy = Breaking the deposit-to-withdrawal link, not hiding the deposit itself

Tax Reporting & Compliance

You control your transaction history:
- Your encrypted notes are stored locally (only you have the decryption key)
- Export full transaction history anytime for tax filing
- Compliance feature (coming before mainnet): Generate tax reports from your note history
- Privacy ≠ Tax evasion - Deposits are visible on-chain, and you can prove withdrawals are yours to authorities if required

---

Fee Structure

Deposit Fees:
- Base Fee: $10 minimum OR 0.1-0.5% (random, whichever higher)
- Why random? Prevents pattern analysis
- Why $10 minimum? To keep fees reasonable. Without a minimum, percentage-based fees on very small deposits (like $5) would be too low to cover gas costs. $10 ensures the protocol remains sustainable.
- Gas Fee: Network gas costs (deducted from deposit)

Swap Fees:
- Protocol Fee: 0.005% of swap amount
- DEX Fee: Variable (0.25-0.3% typically, depending on chain)
- Gas Fee: Network gas costs

Withdrawal Fees:
- Protocol Fee: None
- Gas Fee: Network gas costs (deducted from user's deposited funds)

Fee Distribution:
- 80% → Validators (proportional to stake)
- 20% → Protocol treasury (development, audits, marketing)

---

Gas Handling

How gas works:

User deposits any token (BNB, USDT, CAKE, etc.):
- Gas is paid from the user's deposited funds
- If user deposits USDT, we swap a small portion to BNB for gas
- Relayer submits the transaction and gets reimbursed from the user's deposit
- User never needs to hold BNB separately

Why this works:
- Users can deposit any token without needing BNB
- Gas comes from user funds (relayer just fronts it temporarily)
- Relayers get reimbursed on-chain instantly
- Fully decentralized (anyone can run a relayer)

---

Security

Cryptographic Security:

1. Groth16 zk-SNARKs - Battle-tested proof system (industry standard for privacy protocols)
2. MiMC7 hashing - Efficient and secure in zero-knowledge circuits
3. No custom crypto - We don't invent new cryptography (that's how you get hacked)

Economic Security:

1. Validators have money at risk (their stake)
2. Threshold consensus (66%) prevents censorship, not security bypass
3. On-chain Groth16 verifier is the final security layer (always runs)
4. Progressive penalties - fees → status → stake
5. Reputation system tracks validator accuracy

Smart Contract Security:

- Audited by [TBD - audit before mainnet]
- Upgradeable via proxy pattern (built into contract)
- No pause function (contract cannot be stopped)
- Upgrades require admin proposal + 68% governance vote
- Owner cannot upgrade alone (governance required)
- No admin keys for core security functions

---

Roadmap

Phase 1: Launch (Q1 2026)
- ✅ Testnet deployment (low-cost EVM chain)
- ✅ Validator network (10+ validators)
- ✅ Basic swap functionality
- ✅ DEX integration
- ⏳ Security audit
- ⏳ Mainnet launch

Phase 2: EVM Chain Expansion (Q2 2026)
- Additional EVM chain deployments
- DEX integrations for each chain
- Separate validator sets per chain
- Cross-chain bridge (experimental)

Multi-Chain Expansion (2026-2027)

Q2 2026:
- Ethereum + Uniswap V3
- Polygon
- Arbitrum

Q3 2026:
- Optimism
- Base
- Solana (Rust + Raydium + SPL tokens)

Q4 2026:
- Avalanche
- zkSync Era
- Scroll

2027+:
- Bitcoin (Lightning Network integration)
- 1-3 additional chains per quarter
- Cross-chain privacy (LayerZero or similar)

How multi-chain works:

Each chain gets:
- Its own shielded pool contract
- Its own validator set (local validators earn more on their home chain)
- Native DEX integration (leading DEXs on each chain)
- Same privacy guarantees (Pedersen commitments + zk-SNARKs)

Cross-chain privacy (future):

Right now, if you deposit on one chain and want to withdraw on another, you can't. We're fixing that.

Phase 1: Same-chain privacy (Q1 2026)
Phase 2: Cross-chain bridge (Q3 2026)
Phase 3: Unified liquidity pools (2027)

---

Why Phantom Protocol is different

There are other privacy protocols out there. This is why we're different:

1. Actually decentralized
- No company-run relayers (anyone can run one)
- No single proof verifier (66% validator consensus required)
- No admin keys after launch (all upgrades via governance)

2. Multi-chain from day one
- Most privacy protocols are single-chain only
- We're starting on a fast, low-cost chain and expanding everywhere
- Validators can earn on multiple chains

3. Real liquidity
- Swaps execute on PancakeSwap, Uniswap, etc.
- No custom AMM with thin liquidity
- You get the best price, privately

4. Real UX
- Simple, clean UI (not terminal commands)
- 5-10 second transactions (not 15 minutes)
- Works with MetaMask (no custom wallet needed)

5. Sustainable
- 80/20 fee split (validators earn real money)
- Revenue from day 1 (protocol fees on every transaction)

---

How to Get Involved

Run a validator:
1. Stake 10,000+ PHNTM tokens
2. Run the validator server (Node.js script)
3. Earn 80% of protocol fees

Details: [STAKER_QUICKSTART.md](./STAKER_QUICKSTART.md)

Run a relayer:
1. Stake PHNTM tokens (minimum TBD)
2. Run the relayer backend
3. Earn tips from users

Use the protocol:
- Coming soon

---

FAQ

Q: Is this legal?  
A: Yes. Privacy is not illegal. We comply with regulations, integrate Chainalysis, and block sanctioned addresses.

Q: Can law enforcement trace transactions?  
A: Transactions are visible on-chain, but the link between depositor and withdrawer is broken. Individual identities and amounts are hidden using zero-knowledge proofs and Pedersen commitments.

Q: What if validators collude?  
A: They'd need 34%+ of staked tokens to block transactions. And they'd lose their stake if caught. Not profitable.

Q: Can relayers steal funds?  
A: No. Relayers only submit transactions. They never control your assets.

Q: Wen token?  
A: Soon. Token details will be announced before mainnet launch.

Q: Why start on a lower-cost chain?  
A: Lower gas fees means more accessible for everyone. We'll expand to other major chains by Q2 2026.

---

Conclusion

Privacy in DeFi is broken. We're fixing it.

Phantom Protocol gives you privacy through encryption (to the best level possible on a public blockchain), the liquidity of a DEX, and the security of decentralized validators. No company controlling your funds. No waiting 15 minutes for transactions.

Just private, fast, multi-chain DeFi.

Built for users. Secured by validators. Governed by the community.

Join us.

---

Website: https://phantomproto.com (coming soon)  
Twitter: Coming soon  
Discord: Coming soon  
GitHub: Coming soon  
Docs: Coming soon

---

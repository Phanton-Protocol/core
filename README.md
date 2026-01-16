# Phantom Protocol 👻

**Private DeFi for Everyone**

Phantom Protocol is a cross-chain privacy layer for DeFi that lets you swap, transfer, and store crypto without revealing your financial activity to the world.

---

## Quick Links

- 📄 **[Whitepaper](WHITEPAPER.md)** - Full technical and vision document
- 🚀 **[Staker Guide](STAKER_QUICKSTART.md)** - Run a validator and earn rewards
- 📚 **[Documentation](docs/)** - Technical deep dives
- 🌐 **Website** - https://phantomprotocol.io (coming soon)
- 💬 **Discord** - https://discord.gg/phantom (coming soon)

---

## What We Built

- ✅ **Zero-knowledge swaps** - Trade tokens privately using zk-SNARKs
- ✅ **UTXO-style notes** - Deposit 100, swap 60, get change (like cash bills)
- ✅ **Join-split transactions** - Spend notes, get new notes + change
- ✅ **Decentralized validators** - Stakers verify proofs and earn fees
- ✅ **Multi-chain** - Testnet live now, 1-3 chains per quarter
- ✅ **DEX integration** - Real liquidity, private execution
- ✅ **5-10 second transactions** - Instant validator consensus

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| **Proof System** | Groth16 zk-SNARKs (Circom) |
| **Commitments** | Pedersen commitments (hide amount, token, owner) |
| **Merkle Tree** | MiMC7 hash function |
| **Privacy Flow** | Shadow address + Pedersen commitments + zk-SNARKs |
| **Smart Contracts** | Solidity 0.8.20 (EVM), Rust/Anchor (non-EVM) |
| **DEX Integration** | Leading DEXs on each chain |
| **Validators** | Threshold signatures, 66% consensus |
| **Governance** | Token-based voting (on-chain proposals) |
| **Backend** | Node.js + Express (relayers + validators) |
| **Frontend** | React + Vite + ethers.js |

---

## Getting Started

### For Users

```bash
# Install dependencies
cd frontend
npm install

# Set contract addresses
cp .env.example .env
# Edit .env with deployed addresses

# Start frontend
npm run dev
```

Visit `http://localhost:5173` and connect your wallet!

### For Validators

See **[STAKER_QUICKSTART.md](STAKER_QUICKSTART.md)** for the full guide.

```bash
# 1. Stake tokens
npx hardhat console --network bscTestnet
> await staking.stake(ethers.parseEther("100000"))

# 2. Run validator server
cd backend
export VALIDATOR_PRIVATE_KEY="0x..."
node src/validatorServer.js

# 3. Earn rewards! 💰
```

### For Developers

```bash
# Clone repo
git clone https://github.com/phantom-protocol/core.git
cd core

# Install all dependencies
npm install
cd backend && npm install
cd ../frontend && npm install
cd ..

# Compile circuits
cd circuits
circom joinsplit.circom --r1cs --wasm --sym
snarkjs groth16 setup joinsplit.r1cs pot19_final.ptau joinsplit_0001.zkey
snarkjs zkey export verificationkey joinsplit_0001.zkey verification_key.json
snarkjs zkey export solidityverifier joinsplit_0001.zkey ../contracts/verifier.sol

# Compile contracts
cd ..
npx hardhat compile

# Run tests
npx hardhat test

# Deploy to testnet
export PRIVATE_KEY="0x..."
npx hardhat run scripts/deploy.js --network bscTestnet
```

---

## Project Structure

```
phantom-protocol/
├── contracts/              # Solidity smart contracts
│   ├── core/               # ShieldedPool, validators, staking
│   ├── interfaces/         # Contract interfaces
│   └── libraries/          # Merkle tree, MiMC7
├── circuits/               # Circom zk-SNARK circuits
│   ├── joinsplit.circom    # Main circuit
│   └── verification_key.json
├── backend/                # Relayer & validator servers
│   ├── src/
│   │   ├── index.js        # Relayer API
│   │   ├── validatorServer.js  # Validator node
│   │   └── validatorNetwork.js # Multi-validator client
│   └── config.json
├── frontend/               # React UI
│   ├── src/
│   │   ├── App.jsx         # Main app
│   │   └── api.js          # Backend client
│   └── public/
├── scripts/                # Deployment scripts
├── docs/                   # Documentation
├── WHITEPAPER.md           # Full whitepaper
├── STAKER_QUICKSTART.md    # Validator guide
└── README.md               # This file
```

---

## Roadmap

### Q1 2026 (Now)
- ✅ Testnet deployment (low-cost EVM chain)
- ✅ Validator network (10+ validators)
- ⏳ Security audit
- ⏳ Mainnet launch

### Q2 2026 (1-3 chains)
- Ethereum + Uniswap V3
- Polygon
- Arbitrum

### Q3 2026 (1-3 chains)
- Optimism
- Base
- Solana (Rust + Raydium)

### Q4 2026 (1-3 chains)
- Avalanche
- zkSync Era
- Scroll

### 2027+ (1-3 chains per quarter)
- Bitcoin (Lightning Network integration)
- Additional EVM chains as demand requires
- Cross-chain privacy (LayerZero)
- Encrypted messaging
- Bulk transfers
- Private yield farming

Full roadmap in **[WHITEPAPER.md](WHITEPAPER.md)**

---

## Security

- 🔒 **Audited by [TBD]** - Full audit before mainnet
- 🐛 **Bug bounty** - Up to $100k for critical bugs
- 🔒 **Private repository** - Code available to auditors and partners
- 🔐 **No admin keys** - Fully decentralized after launch
- ⏱️ **Timelock** - 48-hour delay on admin functions

---

## Compliance

- ✅ **Chainalysis integration** - Block sanctioned addresses
- ✅ **zkMe KYC** (optional) - Privacy-preserving identity
- ✅ **AML/KYB compliant** - Legitimate privacy, not money laundering

Privacy ≠ illegal. We build for financial freedom, not crime.

---

## Fee Structure

- **Deposit**: $10 minimum OR 0.1-0.5% (random, whichever higher) + gas fees
- **Swap**: 0.005% of swap amount + DEX fees (PancakeSwap, Uniswap, etc.) + gas fees
- **Withdrawal**: Gas fees only (paid by user or relayer)
- **Distribution**: 80% to validators/stakers, 20% to company treasury

---

## Contributing

We welcome contributions! 

- 🐛 **Bug reports** - Open an issue
- 💡 **Feature requests** - Open a discussion
- 🔧 **Pull requests** - Fix bugs, add features
- 💰 **Bounties** - Earn PHNTM tokens for contributions

See `CONTRIBUTING.md` for guidelines.

---

## License

Proprietary - All rights reserved

This is a private repository. Code is confidential and not for public distribution.

---

## Contact

- **Website**: https://phantomprotocol.io (coming soon)
- **Twitter**: @PhantomProtocol
- **Discord**: https://discord.gg/phantom
- **Telegram**: https://t.me/phantomprotocol
- **Email**: team@phantomprotocol.io

---

## Disclaimer

This is experimental software. Use at your own risk. We've done our best to make it secure, but bugs happen. Don't deposit more than you can afford to lose (especially on testnet!).

Privacy is a right, but so is personal responsibility. Don't use this for illegal activity. We comply with law enforcement when legally required.

---

**Built with by the Phantom Protocol team**

*Phantom-fast. Phantom-private. Phantom Protocol.*

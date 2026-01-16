# Staker Quick Start Guide ⚡

## What You'll Do

As a token staker, you'll run a **validator server** that verifies ZK-SNARK proofs **instantly** and earns rewards. No manual work needed - just keep your server running 24/7!

---

## Step 1: Stake Tokens (One-Time)

```bash
# Approve tokens
npx hardhat console --network bscTestnet
> const token = await ethers.getContractAt("ProtocolToken", "0xb6D673d05255326312c1BAEE0801771C90ceF1eA");
> await token.approve("0x9cD7B3CaCB79d2d33422e78B914cd0c09fb77356", ethers.parseEther("100000"));

# Stake
> const staking = await ethers.getContractAt("RelayerStaking", "0x9cD7B3CaCB79d2d33422e78B914cd0c09fb77356");
> await staking.stake(ethers.parseEther("100000"));
```

**Or use the UI:**
1. Go to http://localhost:5173
2. Click "Staking" tab
3. Enter amount: 100000
4. Click "Stake"

---

## Step 2: Run Validator Server (24/7)

```bash
cd backend

# Set your validator private key
$env:VALIDATOR_PRIVATE_KEY="0x..." # Your staking wallet private key
$env:VALIDATOR_PORT="6000"
$env:VERIFICATION_KEY_PATH="../circuits/verification_key.json"

# Start server
node src/validatorServer.js
```

**Expected output:**
```
🔐 Validator Address: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
⚡ Starting validator server on port 6000...
✅ Verification key loaded
✅ Validator server running!
📡 Endpoint: http://localhost:6000/verify
🎯 Waiting for proof verification requests...
```

---

## Step 3: Expose Your Server (Production)

**For Testing (Local):**
```bash
# Keep it on localhost, relayer will connect locally
```

**For Production (Cloud):**
```bash
# Option A: Deploy to cloud
# AWS, DigitalOcean, Google Cloud, etc.
# Get public IP: e.g., http://51.20.30.40:6000

# Option B: Use ngrok (testing only)
npx ngrok http 6000
# Get URL: https://abc123.ngrok.io
```

---

## Step 4: Register Your Validator

```bash
# Tell the relayer about your endpoint
curl -X POST http://localhost:5050/register-validator \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
    "url": "http://localhost:6000"
  }'
```

---

## Step 5: Earn Rewards! 💰

Your server now:
- ✅ **Automatically verifies** all proofs submitted to the relayer
- ✅ **Signs results** with your private key
- ✅ **Earns rewards** for correct verification
- ✅ **No manual work needed** - runs 24/7

### Rewards:
| Source | Amount |
|--------|--------|
| Protocol fees | 0.1-0.5% of all deposits (passive) |
| Swap fees | 0.005% of all swaps (passive) |
| Verification rewards | ~0.001% per proof verified (active) |

---

## Monitor Your Validator

### Check Health:
```bash
curl http://localhost:6000/health
```

**Response:**
```json
{
  "status": "ok",
  "validator": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
  "uptime": 86400
}
```

### Check Logs:
```bash
# View real-time activity
tail -f validator.log
```

**Example logs:**
```
🔍 Verifying proof...
✅ Proof is VALID (1823ms)
💪 Voting power: 100000.0 tokens
✍️  Signed result (0x8f3e...)
```

---

## Claim Rewards

```bash
# Via CLI
npx hardhat console --network bscTestnet
> const staking = await ethers.getContractAt("RelayerStaking", "0x9cD7B3CaCB79d2d33422e78B914cd0c09fb77356");
> await staking.claim();

# Or via UI
# Go to Staking tab → Click "Claim Rewards"
```

---

## Troubleshooting

### "Verification key not found"
```bash
# Make sure you compiled the circuit
cd circuits
circom joinsplit.circom --r1cs --wasm --sym
snarkjs groth16 setup joinsplit.r1cs pot19_final.ptau joinsplit_0001.zkey
snarkjs zkey export verificationkey joinsplit_0001.zkey verification_key.json
```

### "Port already in use"
```bash
# Change port
$env:VALIDATOR_PORT="6001"
```

### "Validator not responding"
```bash
# Check if server is running
curl http://localhost:6000/health

# Restart if needed
node src/validatorServer.js
```

---

## Run Multiple Validators (Higher Rewards)

```bash
# Terminal 1
$env:VALIDATOR_PRIVATE_KEY="0x..." 
$env:VALIDATOR_PORT="6001"
node src/validatorServer.js

# Terminal 2
$env:VALIDATOR_PRIVATE_KEY="0x..." 
$env:VALIDATOR_PORT="6002"
node src/validatorServer.js

# Terminal 3
$env:VALIDATOR_PRIVATE_KEY="0x..." 
$env:VALIDATOR_PORT="6003"
node src/validatorServer.js
```

More validators = more voting power = more rewards! 💰

---

## Production Deployment

### Using PM2 (Process Manager)
```bash
npm install -g pm2

# Start validator with auto-restart
pm2 start src/validatorServer.js --name validator1

# View logs
pm2 logs validator1

# Monitor
pm2 monit

# Auto-start on reboot
pm2 startup
pm2 save
```

### Using Docker
```dockerfile
# Dockerfile
FROM node:20
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 6000
CMD ["node", "src/validatorServer.js"]
```

```bash
# Build & run
docker build -t shadow-validator .
docker run -d -p 6000:6000 \
  -e VALIDATOR_PRIVATE_KEY="0x..." \
  shadow-validator
```

---

## FAQ

**Q: Do I need to keep my computer on 24/7?**  
A: Yes, or deploy to a cloud server (AWS, DigitalOcean, etc.)

**Q: What happens if I go offline?**  
A: You just miss rewards for that time. No penalty (for now).

**Q: Can I run multiple validators?**  
A: Yes! More stake = more rewards.

**Q: How much can I earn?**  
A: Depends on protocol activity. Example: $10k stake → ~$50-200/month passive + active rewards.

**Q: Is there slashing?**  
A: Not yet. Future versions will slash dishonest validators.

---

## Support

**Issues?**  
- Join Discord: [link]
- Telegram: [link]
- GitHub Issues: [link]

---

## Summary

1. ✅ Stake 100,000 tokens
2. ✅ Run `node src/validatorServer.js`
3. ✅ Earn rewards automatically
4. ✅ Claim rewards when you want

**Total setup time: 10 minutes** ⏱️  
**Passive income: Forever** 💰  

Welcome to the validator network! 🎉

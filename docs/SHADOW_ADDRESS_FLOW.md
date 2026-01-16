# Phantom Address Flow - Privacy Explained

## How Privacy Works in Phantom Protocol

### What's Public vs Private

| Transaction Element | Visible On-Chain? | Private? |
|---------------------|-------------------|----------|
| **Pool's total balance** | ✅ Public | ❌ |
| **Relayer's address** | ✅ Public | ❌ |
| **Your deposit amount** | ❌ Hidden | ✅ |
| **Your balance** | ❌ Hidden | ✅ |
| **Your commitments** | ✅ Public hash | ✅ Meaning hidden |
| **Your nullifiers** | ✅ Public hash | ✅ Link to commitment hidden |
| **Swap details** | ❌ Hidden | ✅ |

## Deposit Flow (Hybrid Model)

### BNB Deposits - DIRECT
```
User Wallet → ShieldedPool
```
✅ **Why Direct**: 
- Relayer can't hold user's BNB (requires trust)
- User's deposit commitment is still encrypted
- Only the deposit transaction is public, not the balance

❌ **Privacy Trade-off**: On-chain shows "User wallet deposited X BNB"

### ERC20 Deposits - SHADOW ADDRESS (PRIVATE)
```
User Wallet → Approve Token → Relayer (Shadow Address) → ShieldedPool
```
✅ **Privacy**: On-chain shows "Relayer deposited X tokens", not linked to your wallet

### How ERC20 Shadow Deposits Work

1. **User**: Approve ERC20 token to relayer address
2. **User**: Sign EIP-712 deposit intent (off-chain)
3. **User**: Send deposit request to relayer backend
4. **Relayer**: Verify signature
5. **Relayer**: Call `depositFor()` on pool
   - Pulls tokens from user via approval
   - Relayer pays gas
   - Relayer's address is `msg.sender`
   - User's address is only in encrypted commitment
6. **Result**: External observers see "Relayer deposited X tokens" (not "User deposited")

## Swap Flow (Already Private)

```
User → ZK Proof (off-chain) → Relayer → Pool.shieldedSwap() → PancakeSwap → Pool
```

✅ **Privacy**:
- Input commitment (what you're spending) = private
- Output commitment (what you're receiving) = private
- Swap amount = hidden in proof
- Only shows: "Pool swapped X for Y via PancakeSwap"

## Withdraw Flow (Shadow Address)

### Current Flow
```
User → ZK Proof → Relayer → Pool.withdraw(recipient=User) → User
```
⚠️ **Issue**: Recipient address is public

### Recommended Flow
```
User → ZK Proof → Relayer → Pool.withdraw(recipient=Relayer) → Relayer → User
```
✅ **Privacy**: On-chain shows "Pool sent X to Relayer" (not to User)

### How to Enable Shadow Withdrawals

1. Set `recipient` in withdraw proof to **relayer address**
2. Include encrypted payload with real recipient
3. Relayer decrypts and forwards to real user

## Real-Time Price Integration

### DEXScreener API (Production)
```javascript
// Automatic fallback: DEXScreener → Mock prices
const price = await getDexPriceUsd(tokenAddress, "bsc");
```

**Testnet Note**: DEXScreener may not have testnet data, so we use realistic mock prices:
- BNB = $600
- USDT/USDC/BUSD = $1
- CAKE = $5
- ETH = $3,000
- BTC = $60,000

**Mainnet**: Will use real-time DEXScreener prices automatically.

## Summary

✅ **What's Already Private**:
- Your balance (encrypted local notes)
- Swap amounts & tokens
- Commitment meanings

✅ **What's Now Private (Shadow Address)**:
- ERC20 deposits (via `depositFor()` - relayer submits)

⚠️ **Hybrid Approach**:
- BNB deposits: Direct (user → pool) for trustless flow
- ERC20 deposits: Shadow (user → relayer → pool) for privacy

🔄 **What Can Be Private** (Optional):
- Withdrawals (set recipient = relayer, add encrypted payload)

❌ **What Cannot Be Private** (Blockchain Limitation):
- Pool's total balance
- Total number of deposits
- Gas fees paid

## For Production Deployment

1. ✅ Enable DEXScreener real-time prices
2. ✅ ALL deposits via shadow address (relayer)
3. ✅ Proof-based swaps (already private)
4. 🔄 Optional: Shadow withdrawals (add encrypted recipient)
5. ✅ Monitor relayer balance (needs BNB for gas)

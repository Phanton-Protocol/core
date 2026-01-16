# Off-chain Oracle Signer (Dexscreener)

This script fetches token prices from **Dexscreener**, signs the update, and submits it to `OffchainPriceOracle`.

## Setup

```bash
npm install
```

## Env

```
RPC_URL=https://bsc-dataseed1.binance.org
PRIVATE_KEY=0x...
ORACLE_ADDRESS=0xYourOffchainPriceOracle
TOKEN_ADDRESS=0xTokenToPrice
CHAIN_ID=56
CHAIN_SLUG=bsc
PAIR_ADDRESS=0xPairAddressOptional
```

## Run

```bash
node scripts/oracle/dexscreenerSigner.js
```

### Optional filters

- `CHAIN_SLUG`: filters the best pair by chain (e.g. `bsc`, `ethereum`)
- `PAIR_ADDRESS`: uses a specific pair (requires `CHAIN_SLUG`)

## Testnet Mock Signer (Recommended)

Dexscreener does **not** index most testnet tokens. Use the mock signer on testnet:

```bash
RPC_URL=... \
PRIVATE_KEY=... \
ORACLE_ADDRESS=0x... \
TOKEN_ADDRESS=0x... \
PRICE_USD=245.12 \
CHAIN_ID=97 \
node scripts/oracle/mockSigner.js
```

## Notes

- Uses the pair with **highest USD liquidity**.
- Price is normalized to **8 decimals** (1e8).
- Nonce uses the current timestamp to avoid reuse.

## Optional: Dextools

If you want to use Dextools instead, you can swap the price fetcher with your Dextools API client.

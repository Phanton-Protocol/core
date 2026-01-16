# Shadow-DeFi Relayer API

## Setup

```
npm install
```

## Config

Use env vars or copy `backend/config.example.json` values into your environment.
Keep private keys out of files; set them in your shell when you run the backend.

## Run

```
npm run dev
```

Example (PowerShell):
```
$env:RELAYER_PRIVATE_KEY="0xYOUR_RELAYER_KEY"
$env:ORACLE_SIGNER_PRIVATE_KEY="0xYOUR_ORACLE_SIGNER_KEY"
npm run dev
```

## Endpoints

- `POST /quote`
- `POST /intent`
- `POST /swap`
- `GET /receipt/:intentId`
- `POST /oracle/update`

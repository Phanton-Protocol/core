# Experimental contracts (out of Path-B production scope)

These Solidity modules are research / R&D derivatives. They are **not** deployed by
`deploy-pathb-reduced.ts` and must not be enabled on staging/production deploys.

| Contract | Notes |
|---|---|
| `AdvancedPrivacyPool` | FHE / MPC placeholders |
| `FHEEncryptedPool` | Mock FHE balance path |
| `InternalMatchingPool` | On-chain order book (EIP-170 oversized) |
| `DarkPool` | Batch / intent matching prototype |
| `EncryptedPool`, `PrivacyEnhancedPool`, `HybridPrivacyPool`, `PrivateSwapPool`, `AntiAnalysisPool` | Stacked research variants |
| `DynamicPoolFactory` | Factory for experimental pool types |

Path-B production target: `ShieldedPoolUpgradeableReduced` only.

Alternate (not production): `ShieldedPool`, `ShieldedPoolUpgradeable` — see `docs/PATH_B_PRODUCTION_RUNBOOK.md`.

Deploy scripts call `assertExperimentalDeployBlocked()` from `scripts/deploy/networkConfig.ts`
to reject `DEPLOY_*` env flags that would opt into these contracts when
`DEPLOY_PROFILE` is `staging`/`production`, or dev with `FORCE_MOCK_INFRASTRUCTURE=false`.

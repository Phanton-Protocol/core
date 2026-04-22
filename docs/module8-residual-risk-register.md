# Module 8 Residual Risk Register

| Priority | Risk | Impact | Owner | Mitigation | Status |
|---|---|---|---|---|---|
| P0 | Testnet-to-mainnet behavior drift (RPC/provider latency, mempool variance) | Settlement instability or retriable spikes | Relayer Ops | Keep phased rollout, enforce retriable/failure thresholds, fallback to dry-run on breach | Open |
| P0 | SEE auth propagation regressions in clients | Internal route request failures (401/403) | Frontend + Platform | Monitor SEE auth failure spike, add client smoke checks before release | Open |
| P1 | Attestation signer-set drift vs policy config | Valid matches blocked or unsafe acceptance | Validator Ops | Monitor attestation failure reason mix, validate signer set hash rollout process | Open |
| P1 | Compliance provider drift (false positives/holds) | Throughput reduction and user friction | Compliance Ops | Baseline comparison alerts, controlled policy version rollouts | Open |
| P1 | Frontend lint debt outside internal matching scope | Potential hidden regressions over time | Frontend | Resolve existing lint errors in shared components (`Navbar`, `WhitepaperDiagrams`) | Open |
| P2 | E2E canary dependencies (wallet funding, withdraw handler wiring) | Delayed validation cycles | DevOps | Preflight checks and explicit prerequisites in canary runbook | Open |


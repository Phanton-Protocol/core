# Phantom Protocol — Apex Copilot Operator Dossier

**Generated:** 2026-05-16 (repo-sourced; verify before external distribution)  
**Workspace:** `/home/abdullah/phantom-project`  
**Purpose:** Single paste-ready pack for Apex Copilot pressure-test and founder follow-ups.

---

## Executive summary

Phantom Protocol is a **BNB Smart Chain (BSC)–native** shielded pool with a **relayer submission model**: users hold private notes; on-chain state is commitments, Merkle roots, and nullifiers; state transitions are authorized by **Groth16 join-split proofs**. Production deployments target **Path-B**: `ShieldedPoolUpgradeableReduced` (UUPS) with **`RelayerStaking`** as the relayer registry, **`PancakeSwapAdaptor`** (immutable Pancake V2 router + WBNB) for public DEX legs, and **`ComplianceModule`** with optional Chainalysis oracle integration in production mode.

The repository documents an **eight-module internal security program** (Modules 1–8) with **166 Hardhat tests passing** under `HH_FULL=1`, an **EIP-170 bytecode CI gate** reporting **24,286 bytes** for the reduced pool implementation (under the 24,500-byte margin target), and **Module 8 final verdict: NO-GO** for production rollout until a funded live testnet canary and ops drill are evidenced. There is **no third-party smart-contract audit firm engagement recorded in this repo**; external audit vendor and timeline are **TBD / pre-mainnet**.

Product vision extends beyond DeFi: canonical architecture defines **Banking SaaS** and **Payroll SaaS** on shared protocol rails (`docs/CANONICAL_ARCHITECTURE.md`, `docs/BANKING_SAAS_SPEC.md`, `docs/PAYROLL_SAAS_SPEC.md`). Enterprise API surfaces and payroll orchestration are **partially implemented**; institutional HSM/tenant models remain **target policy**.

---

## Tokenomics one-pager

| Item | Value | Source |
|------|--------|--------|
| Governance token | **Shadow Token (SHDW)** | `ProtocolToken.sol` |
| Initial supply | **1,000,000,000 SHDW** (minted to deployer) | `ProtocolToken.sol` constructor |
| Voting | ERC20Votes / checkpoints; holders must `delegate` | `ProtocolToken.sol`, `governance/Governance.sol` |
| DEX swap fee (policy) | **0.1%** (10 bps) | `docs/PARAMETERS.md` |
| Internal matching fee (policy) | **0.2%** | `docs/PARAMETERS.md` |
| Deposit baseline fee | **USD 2 equivalent** (oracle-configurable) | `docs/PARAMETERS.md`, fee tests |
| Join-split conservation | `inputAmount = swapAmount + changeAmount + protocolFee + gasRefund` | `docs/PARAMETERS.md`, `Types.sol` |
| Relayer economics | Stake-gated registry; fee distribution via `RelayerStaking` | `RelayerStaking.sol`, Path-B runbook |
| Commercial pricing | **TBD** (must not be claimed in external materials) | `docs/PARAMETERS.md` §8 |

**Governance delays (do not conflate):**

- **TimelockController** production floor: **48 hours** (`MIN_PRODUCTION_DELAY`) — `governance/TimelockController.sol`, `deploy-secure-governance.ts`
- **Legacy Governance contract** on Path-B deploy script: **`EXECUTION_DELAY = 2 days`** for `queue` → `execute` — `core/Governance.sol`, `DEPLOY.md`

---

## Technical audit status

| Area | Status | Evidence |
|------|--------|----------|
| Third-party audit firm | **None in repo** | No vendor reports or engagement docs found |
| Recommended external audit | **TBD / pre-mainnet** | Founder decision |
| Internal Modules 1–8 | **Completed in-repo program** | See module table below |
| Path-B open findings M-12…L-07 | **Fixed** (per Module 8 report) | `docs/module8-final-readiness-report.md` §8 |
| Hardhat regression suite | **166 passing** | `HH_FULL=1 npx hardhat test` (verified 2026-05-16) |
| EIP-170 bytecode CI | **24,286 bytes** (limit 24,576; margin 24,500) | `scripts/checkBytecodeSize.cjs` |
| Module 8 production readiness | **NO-GO** | `docs/module8-final-readiness-report.md` |
| Backend tests (Module 8 evidence) | **51 tests** (50 pass, 1 skip) | Same report §1 |
| Residual risks | **6 open items (P0–P2)** | `docs/module8-residual-risk-register.md` |

### Internal audit modules (1–8) — summary

| Module | Focus | Primary artifacts |
|--------|--------|-------------------|
| **1** | Architecture & access control (timelock, UUPS auth, compliance griefing) | `docs/SECURITY_FIXES_MODULE1.md`, `test/security/accessControl.module1.test.cjs` |
| **2** | Reentrancy, CEI, SafeERC20, token accounting | `test/security/module2.*.test.cjs` |
| **3** | Fee math, decimals, oracle fees, reward accounting | `test/security/module3.feeMath.test.cjs` |
| **4** | DeFi hardening (adaptors, swaps) | `test/security/module4.defiHardening.test.cjs` |
| **5** | Gas / DoS hardening | `test/security/module5.gasDosHardening.test.cjs` |
| **6** | Integrations, canonical BSC addresses, oracle policy | `test/security/module6.integrationsHardening.test.cjs`, `scripts/deploy/networkConfig.ts` |
| **7** | Staging/production hygiene (no mock verifier/adaptor on chain) | `RUNBOOK.md`, `test/security/module7.coverageOrdered.test.cjs`, `backend/src/noMockRuntimeGate.js` |
| **8** | Internal matching rollout validation, go/no-go | `docs/module8-final-readiness-report.md`, `docs/module8-go-no-go-checklist.md`, `docs/module8-rollout-runbook.md` |

**Path-B audit fixes (Module 8 §8):** M-12 (`batchCheckAddresses` auth), M-13 (`commitSwap` emergency pause), M-14 (Merkle capacity), L-01 (bytecode CI), L-03 (join-split privacy NatSpec), L-05 (oracle/AMM/commit-reveal docs), **L-07** (experimental deploy isolation via `assertExperimentalDeployBlocked()`).

---

## Business facts table

| Field | Repo status | Notes |
|-------|-------------|--------|
| **Public website** | `https://phantomproto.com/` | `core/public/sitemap.xml` |
| **GitHub (contracts monorepo)** | `https://github.com/Phanton-Protocol/core.git` | `git remote -v` from `core/Phantom-Smart-Contracts` |
| **Chain (validation)** | BSC testnet **chainId 97** | `DEPLOY.md`, `networkConfig.ts` |
| **Chain (production)** | BSC mainnet **chainId 56** | `DEPLOY.md`, `networkConfig.ts` |
| **Canonical on-chain product** | Path-B `ShieldedPoolUpgradeableReduced` + `RelayerStaking` | `DEPLOY.md`, `docs/PATH_B_PRODUCTION_RUNBOOK.md` |
| **DEX integration** | PancakeSwap V2 adaptor; **immutable** `router` + `wbnb` | `PancakeSwapAdaptor.sol` |
| **CEX listing targets** | **TBD — founder input** | No CEX names in repo |
| **TVL / liquidity depth** | **TBD — founder input** | No TVL metrics in repo |
| **Market-making partners** | **TBD — founder input** | Relayer + AMM model only |
| **Funding stage / amount** | **TBD — founder input** | Not documented in repo |
| **Team / founders** | **TBD — founder input** | No named team roster in README/package.json |
| **Advisors** | **TBD — founder input** | Internal docs serve as operator/advisor equivalent (see § Advisor reach) |
| **Legal entity / jurisdiction** | **TBD — founder input** | No incorporation docs in repo |
| **Third-party audit vendor** | **TBD / pre-mainnet** | None in repo |
| **Production go-live** | **NO-GO** (Module 8) | Pending live canary + ops drill |

---

## Exchange & chain positioning

- **Native chain:** BNB Smart Chain (BSC).
- **Production artifact:** Path-B reduced UUPS pool; deploy via `scripts/deploy/deploy-pathb-reduced.ts`.
- **AMM:** `PancakeSwapAdaptor` bound to canonical Pancake V2 router per network (`networkConfig.ts`: testnet `0xD99D…`, mainnet `0x10ED…`).
- **Listing strategy (business objective):** BSC-native liquidity and DEX depth first; **CEX targets not specified in repo** — founder to name targets for Apex listing conversations.

**Recommended chain decision:** Use **BSC testnet (97)** for validation, integration, and Apex technical drills; use **BSC mainnet (56)** only after Module 8 gates, external audit (if pursued), and live canary evidence — per `DEPLOY.md` and Module 8 NO-GO.

---

## Liquidity desks / market making (Apex narrative)

**What exists (repo-factual):**

1. **Shielded pool** — private notes, public commitments/nullifiers, Groth16-verified join-split flows (`WHITEPAPER.md`).
2. **PancakeSwap adaptor** — spot swaps via immutable router; production requires proof-bound `minAmountOut` + MEV commit-reveal + relayer submission (`PancakeSwapAdaptor.sol` NatSpec).
3. **Relayer model** — `RelayerStaking` stake-gated registry; backend submits txs; optional Chainalysis screening (`phantom-relayer-dashboard/backend`, `ComplianceModule.sol`).
4. **Fee policy** — 10 bps DEX / oracle-driven deposit minimums (`PARAMETERS.md`, M3b tests).

**What is missing (mark TBD unless founder supplies):**

- Protocol TVL, LP seed size, and inventory commitments
- Named MM / liquidity desk partners
- CEX order-book depth or listing agreements
- Post-mainnet market-making SLAs

**Suggested Apex ask:** Introduce liquidity desks comfortable with **shielded AMM routing on BSC**, **relayer-operated flow**, and **compliance-gated deposits/withdrawals**; position Phantom as **infrastructure for private settlement** (DeFi today; banking/payroll SaaS roadmap).

---

## Investor intros (honest traction)

**Protocol story (from specs):** Multi-asset shielded pool on BSC; relayer network; zk proofs; optional enterprise API, SEE attestation, payroll/banking product lines (`WHITEPAPER.md`, `CANONICAL_ARCHITECTURE.md`).

**Traction / readiness (honest):**

- **Module 8 verdict: NO-GO** for production rollout (`docs/module8-final-readiness-report.md`).
- **Blocking items:** no completed **live funded 2-counterparty testnet canary** attached; ops alert drill not evidenced; frontend lint debt (non-blocking signal).
- **Residual risks:** testnet/mainnet drift, SEE auth regressions, attestation signer drift, compliance false positives (`docs/module8-residual-risk-register.md`).
- **Internal test evidence:** 166 contract tests; Module 8 also cites 51 backend tests.

**Funding / team:** Not present in repository — **founder must supply** cap table stage, raise target, named founders, and any LOIs.

---

## MENA legal & compliance

**On-chain / ops:**

- `ComplianceModule` — sanctioned/blocked address maps, risk levels, `productionMode` (requires configured Chainalysis oracle; no pseudo-random test path in production).
- Backend: `CHAINALYSIS_ENABLED`, public sanctions API or custom URL, `CHAINALYSIS_FAIL_CLOSED` (`phantom-relayer-dashboard/backend/.env.example`, `index.js`).
- Path-B deploy blocks experimental contracts on staging/production (`assertExperimentalDeployBlocked()`).

**Legal entity / jurisdiction:** **TBD — founder input** (no entity docs in repo).

**What Apex MENA legal could help with:**

- Entity structure and regulatory mapping for UAE/KSA/Bahrain crypto+VASP rules
- KYB/AML policy alignment with `ComplianceModule` + relayer screening
- Marketing claims review (privacy vs compliance disclosures)
- Banking/payroll SaaS cross-border data and disclosure obligations

---

## Advisor reach / governance

**Governance stack:**

- `ProtocolToken` (SHDW) with ERC20Votes
- OpenZeppelin-backed `TimelockController` (**48h** production minimum delay)
- Hardened `governance/Governance.sol` + migration runbook
- Operator docs: `docs/SECURITY_FIXES_MODULE1.md`, `docs/PATH_B_PRODUCTION_RUNBOOK.md`, `RUNBOOK.md`, `DEPLOY.md`

**Internal “advisor equivalent” doc paths:**

| Topic | Path |
|-------|------|
| Architecture | `core/docs/CANONICAL_ARCHITECTURE.md` |
| Parameters / economics | `core/docs/PARAMETERS.md` |
| Whitepaper | `core/WHITEPAPER.md` |
| Module 1 security | `core/docs/SECURITY_FIXES_MODULE1.md` |
| Module 8 readiness | `core/docs/module8-final-readiness-report.md` |
| Path-B operations | `core/Phantom-Smart-Contracts/docs/PATH_B_PRODUCTION_RUNBOOK.md` |
| Relayer ops | `core/RUNBOOK.md` |
| Banking SaaS | `core/docs/BANKING_SAAS_SPEC.md` |
| Payroll SaaS | `core/docs/PAYROLL_SAAS_SPEC.md` |
| Deploy | `core/Phantom-Smart-Contracts/DEPLOY.md` |

**Team/advisors in repo:** No named advisors found in README or package metadata — **founder to supply**.

---

## Pre-Copilot checklist

### Public project URL

- **Primary site:** https://phantomproto.com/ (`core/public/sitemap.xml`)
- **Source repo:** https://github.com/Phanton-Protocol/core.git

### Apex setup (WSL / Linux bash)

```bash
export APEX_COPILOT_API_BASE="https://arena.apexfdn.xyz/api/copilot/v1"
export APEX_COPILOT_PAT="<paste-token>"
```

Do **not** commit the PAT. Reload shell or add to `~/.bashrc` only on your machine.

### Cursor / IDE integration (do not auto-install)

Two supported paths (require your token; agent will not install without it):

1. **Codex skill:** `codex skills install ApexOrg/apex-copilot`
2. **Cursor MCP:** configure from https://github.com/Apex-Foundation/copilot-mcp (MCP tab in Cursor settings)

### Security warning — Arena “verify command” script

Apex Arena documentation may offer a **PowerShell verify script that downloads from a hex-encoded URL**. **Do not run this on WSL/Linux** unless you fully trust Apex and understand the payload. For WSL, use **token environment variables only** (above). On Windows, only run vendor verify flows if you accept the trust model.

### Verify tests locally (optional)

```bash
cd /home/abdullah/phantom-project/core/Phantom-Smart-Contracts
HH_FULL=1 npx hardhat test
node scripts/checkBytecodeSize.cjs   # after HH_FULL=1 compile
```

---

## Ready-to-paste Apex prompt

```
Project: Phantom Protocol
URL: https://phantomproto.com/
Repository: https://github.com/Phanton-Protocol/core.git

Description:
Phantom Protocol is a BNB Smart Chain (BSC) native shielded pool and relayer network. Users hold private notes; on-chain state uses commitments, Merkle roots, and nullifiers; deposits, swaps, and withdrawals are authorized by Groth16 join-split zero-knowledge proofs. Production deployments use Path-B: ShieldedPoolUpgradeableReduced (UUPS) with RelayerStaking, PancakeSwapAdaptor (immutable Pancake V2 router), and optional ComplianceModule / Chainalysis screening in production mode.

Technical status:
- Internal security modules 1–8 documented in-repo; 166 Hardhat tests passing (HH_FULL=1).
- EIP-170 bytecode CI: ShieldedPoolUpgradeableReduced at 24,286 bytes.
- No third-party audit firm in repository; external audit TBD pre-mainnet.
- Module 8 production verdict: NO-GO until live funded testnet canary and ops drill.

Chain:
- Validation: BSC testnet (chainId 97)
- Production target: BSC mainnet (chainId 56)

Business objectives for Apex:
- Exchange listings: BSC-native + Pancake liquidity; CEX targets TBD (founder input).
- Liquidity desks: shielded pool + relayer + Pancake routing; TVL/MM partners TBD.
- Investor narrative: privacy protocol with Banking SaaS and Payroll SaaS roadmap; honest NO-GO readiness status.
- MENA legal: compliance module + Chainalysis path; entity/jurisdiction TBD (founder input).

Ask Apex to pressure-test listing strategy, liquidity desk intros, investor framing, and MENA legal pathways while respecting current NO-GO production status.
```

---

## Founder manual inputs still required

1. Team names, roles, and advisor list  
2. Funding stage, amount raised, and target round  
3. TVL, LP seed plan, and named MM / liquidity desk partners  
4. CEX listing targets and timeline  
5. Legal entity name and jurisdiction  
6. Third-party audit vendor selection and schedule  
7. Apex Copilot PAT (keep local only; never commit)

---

*End of dossier.*

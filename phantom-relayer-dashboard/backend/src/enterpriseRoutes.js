const express = require("express");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function resolveWritableEnterpriseDir(preferredDir) {
  const candidates = [];
  if (preferredDir) candidates.push(preferredDir);
  candidates.push("/tmp/enterprise");
  for (const dir of candidates) {
    try {
      ensureDir(dir);
      const probe = path.join(dir, ".write-probe");
      fs.writeFileSync(probe, "ok", "utf8");
      fs.unlinkSync(probe);
      return dir;
    } catch (_) {
      // Try the next candidate directory.
    }
  }
  throw new Error("No writable enterprise data directory available");
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload), "utf8");
}

function createStore(baseDir) {
  ensureDir(baseDir);
  const files = {
    reportingKeys: path.join(baseDir, "reporting-keys.json"),
    complianceDecisions: path.join(baseDir, "compliance-decisions.json"),
    payrollRuns: path.join(baseDir, "payroll-runs.json"),
    ledgerAccounts: path.join(baseDir, "ledger-accounts.json"),
    ledgerEntries: path.join(baseDir, "ledger-entries.json"),
    governanceProposals: path.join(baseDir, "governance-proposals.json"),
    governanceVotes: path.join(baseDir, "governance-votes.json"),
    auditEvents: path.join(baseDir, "audit-events.json"),
    matchingOrders: path.join(baseDir, "matching-orders.json"),
  };
  const defaults = {
    reportingKeys: [],
    complianceDecisions: [],
    payrollRuns: [],
    ledgerAccounts: [],
    ledgerEntries: [],
    governanceProposals: [],
    governanceVotes: [],
    auditEvents: [],
    matchingOrders: [],
  };
  function get(table) {
    return readJson(files[table], defaults[table]);
  }
  function set(table, value) {
    writeJson(files[table], value);
  }
  return { get, set };
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function appendAudit(store, type, payload) {
  const events = store.get("auditEvents");
  events.push({ id: makeId("audit"), ts: nowTs(), type, payload });
  if (events.length > 5000) events.shift();
  store.set("auditEvents", events);
}

function verifyMessageSignature(wallet, message, signature) {
  const signer = ethers.verifyMessage(String(message), String(signature));
  return signer.toLowerCase() === String(wallet).toLowerCase();
}

function createEnterpriseRouter() {
  const router = express.Router();
  const requestedDir = process.env.ENTERPRISE_DATA_DIR || path.join(__dirname, "..", "data", "enterprise");
  const dataDir = resolveWritableEnterpriseDir(requestedDir);
  const store = createStore(dataDir);
  const enterpriseApiKey = String(process.env.ENTERPRISE_API_KEY || "").trim();

  function requireEnterpriseApiKey(req, res, next) {
    if (!enterpriseApiKey) return next();
    const incoming = String(req.headers["x-enterprise-api-key"] || "").trim();
    if (!incoming || incoming !== enterpriseApiKey) {
      return res.status(401).json({ error: "unauthorized_enterprise_api_key" });
    }
    return next();
  }

  router.get("/health", (req, res) => {
    const orders = store.get("matchingOrders");
    const openOrders = orders.filter((o) => o.status === "open").length;
    res.json({ ok: true, openOrders, ts: nowTs() });
  });

  router.post("/tax-reporting-keys", (req, res) => {
    const { wallet, signature, message } = req.body || {};
    if (!wallet || !ethers.isAddress(wallet) || !signature || !message) {
      return res.status(400).json({ error: "wallet, signature and message are required" });
    }
    if (!verifyMessageSignature(wallet, message, signature)) {
      return res.status(400).json({ error: "invalid signature" });
    }
    const keys = store.get("reportingKeys");
    const value = ethers.hexlify(ethers.randomBytes(32));
    const rec = {
      id: makeId("rkey"),
      wallet: wallet.toLowerCase(),
      key: value,
      active: true,
      createdAt: nowTs(),
      revokedAt: null,
    };
    keys.push(rec);
    store.set("reportingKeys", keys);
    appendAudit(store, "reporting_key_created", { wallet: rec.wallet, keyId: rec.id });
    res.json({ keyId: rec.id, key: rec.key, createdAt: rec.createdAt });
  });

  router.post("/tax-reporting-keys/revoke", (req, res) => {
    const { wallet, signature, message } = req.body || {};
    if (!wallet || !ethers.isAddress(wallet) || !signature || !message) {
      return res.status(400).json({ error: "wallet, signature and message are required" });
    }
    if (!verifyMessageSignature(wallet, message, signature)) {
      return res.status(400).json({ error: "invalid signature" });
    }
    const keys = store.get("reportingKeys");
    let revoked = 0;
    const updated = keys.map((k) => {
      if (k.wallet === wallet.toLowerCase() && k.active) {
        revoked += 1;
        return { ...k, active: false, revokedAt: nowTs() };
      }
      return k;
    });
    store.set("reportingKeys", updated);
    appendAudit(store, "reporting_key_revoked", { wallet: wallet.toLowerCase(), revoked });
    res.json({ revoked });
  });

  router.get("/tax-export", (req, res) => {
    const key = String(req.query.key || req.headers["x-tax-reporting-key"] || "");
    if (!key) return res.status(400).json({ error: "missing key" });
    const keys = store.get("reportingKeys");
    const match = keys.find((k) => k.key === key && k.active);
    if (!match) return res.status(403).json({ error: "invalid reporting key" });
    const audits = store.get("auditEvents").filter((e) => (e.payload?.wallet || "").toLowerCase() === match.wallet);
    res.json({ wallet: match.wallet, generatedAt: nowTs(), events: audits });
  });

  router.post("/compliance/screen", (req, res) => {
    const { wallet, amount, token, source } = req.body || {};
    if (!wallet || !ethers.isAddress(wallet)) return res.status(400).json({ error: "invalid wallet" });
    const wei = BigInt(amount || "0");
    const blocked = wei > 10_000n * 10n ** 18n;
    const decision = {
      id: makeId("scr"),
      wallet: wallet.toLowerCase(),
      token: token || ethers.ZeroAddress,
      source: source || "unknown",
      amount: wei.toString(),
      riskScore: blocked ? 95 : 15,
      status: blocked ? "blocked" : "approved",
      reason: blocked ? "amount_above_policy_limit" : "passed_basic_rules",
      createdAt: nowTs(),
    };
    const rows = store.get("complianceDecisions");
    rows.push(decision);
    store.set("complianceDecisions", rows);
    appendAudit(store, "compliance_screened", decision);
    res.json(decision);
  });

  router.get("/compliance/decisions", (req, res) => {
    if (requireEnterpriseApiKey(req, res, () => {}) === undefined && res.headersSent) return;
    res.json(store.get("complianceDecisions").slice(-200).reverse());
  });

  router.post("/payroll/runs", (req, res) => {
    if (requireEnterpriseApiKey(req, res, () => {}) === undefined && res.headersSent) return;
    const { companyId, currencyAssetId, items } = req.body || {};
    if (!companyId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "companyId and items are required" });
    }
    const run = {
      id: makeId("payrun"),
      companyId: String(companyId),
      currencyAssetId: Number(currencyAssetId || 0),
      status: "draft",
      createdAt: nowTs(),
      updatedAt: nowTs(),
      items: items.map((it, i) => ({
        id: makeId(`payitem${i}`),
        recipient: String(it.recipient || "").toLowerCase(),
        amount: String(it.amount || "0"),
        memo: String(it.memo || ""),
        status: "pending",
      })),
    };
    const rows = store.get("payrollRuns");
    rows.push(run);
    store.set("payrollRuns", rows);
    appendAudit(store, "payroll_run_created", { runId: run.id, companyId: run.companyId, count: run.items.length });
    res.json(run);
  });

  router.post("/payroll/runs/:runId/approve", (req, res) => {
    if (requireEnterpriseApiKey(req, res, () => {}) === undefined && res.headersSent) return;
    const rows = store.get("payrollRuns");
    const idx = rows.findIndex((r) => r.id === req.params.runId);
    if (idx < 0) return res.status(404).json({ error: "run not found" });
    rows[idx].status = "approved";
    rows[idx].updatedAt = nowTs();
    store.set("payrollRuns", rows);
    appendAudit(store, "payroll_run_approved", { runId: rows[idx].id });
    res.json(rows[idx]);
  });

  router.post("/payroll/runs/:runId/execute", (req, res) => {
    if (requireEnterpriseApiKey(req, res, () => {}) === undefined && res.headersSent) return;
    const rows = store.get("payrollRuns");
    const idx = rows.findIndex((r) => r.id === req.params.runId);
    if (idx < 0) return res.status(404).json({ error: "run not found" });
    if (rows[idx].status !== "approved") return res.status(400).json({ error: "run must be approved first" });
    rows[idx].status = "executing";
    rows[idx].updatedAt = nowTs();
    rows[idx].items = rows[idx].items.map((it) => ({
      ...it,
      status: "settled",
      txHash: ethers.keccak256(ethers.toUtf8Bytes(`${rows[idx].id}:${it.id}:${Date.now()}`)),
      settledAt: nowTs(),
    }));
    rows[idx].status = "completed";
    rows[idx].completedAt = nowTs();
    store.set("payrollRuns", rows);
    appendAudit(store, "payroll_run_executed", { runId: rows[idx].id, settled: rows[idx].items.length });
    res.json(rows[idx]);
  });

  router.get("/payroll/runs", (req, res) => {
    if (requireEnterpriseApiKey(req, res, () => {}) === undefined && res.headersSent) return;
    res.json(store.get("payrollRuns").slice(-100).reverse());
  });

  router.post("/ledger/accounts", (req, res) => {
    if (requireEnterpriseApiKey(req, res, () => {}) === undefined && res.headersSent) return;
    const { tenantId, code, name, type } = req.body || {};
    if (!tenantId || !code || !name || !type) return res.status(400).json({ error: "tenantId, code, name, type are required" });
    const accounts = store.get("ledgerAccounts");
    const rec = { id: makeId("acct"), tenantId: String(tenantId), code: String(code), name: String(name), type: String(type), createdAt: nowTs() };
    accounts.push(rec);
    store.set("ledgerAccounts", accounts);
    appendAudit(store, "ledger_account_created", rec);
    res.json(rec);
  });

  router.post("/ledger/post", (req, res) => {
    if (requireEnterpriseApiKey(req, res, () => {}) === undefined && res.headersSent) return;
    const { tenantId, memo, legs } = req.body || {};
    if (!tenantId || !Array.isArray(legs) || legs.length < 2) return res.status(400).json({ error: "tenantId and at least two legs are required" });
    let debit = 0n;
    let credit = 0n;
    for (const leg of legs) {
      const amt = BigInt(String(leg.amount || "0"));
      if (leg.side === "debit") debit += amt;
      if (leg.side === "credit") credit += amt;
    }
    if (debit !== credit) return res.status(400).json({ error: "entry is not balanced" });
    const entries = store.get("ledgerEntries");
    const entry = { id: makeId("entry"), tenantId: String(tenantId), memo: String(memo || ""), legs, createdAt: nowTs() };
    entries.push(entry);
    store.set("ledgerEntries", entries);
    appendAudit(store, "ledger_entry_posted", { id: entry.id, tenantId: entry.tenantId, legs: legs.length });
    res.json(entry);
  });

  router.get("/ledger/accounts", (req, res) => {
    if (requireEnterpriseApiKey(req, res, () => {}) === undefined && res.headersSent) return;
    const tenantId = String(req.query.tenantId || "");
    const rows = store.get("ledgerAccounts");
    res.json(tenantId ? rows.filter((r) => r.tenantId === tenantId) : rows);
  });

  router.get("/ledger/entries", (req, res) => {
    if (requireEnterpriseApiKey(req, res, () => {}) === undefined && res.headersSent) return;
    const tenantId = String(req.query.tenantId || "");
    const rows = store.get("ledgerEntries");
    res.json(tenantId ? rows.filter((r) => r.tenantId === tenantId) : rows);
  });

  router.post("/governance/proposals", (req, res) => {
    if (requireEnterpriseApiKey(req, res, () => {}) === undefined && res.headersSent) return;
    const { proposer, title, description } = req.body || {};
    if (!proposer || !ethers.isAddress(proposer) || !title) return res.status(400).json({ error: "proposer and title are required" });
    const proposals = store.get("governanceProposals");
    const rec = { id: makeId("prop"), proposer: proposer.toLowerCase(), title: String(title), description: String(description || ""), status: "active", createdAt: nowTs() };
    proposals.push(rec);
    store.set("governanceProposals", proposals);
    appendAudit(store, "governance_proposal_created", { proposalId: rec.id, proposer: rec.proposer });
    res.json(rec);
  });

  router.post("/governance/proposals/:id/vote", (req, res) => {
    if (requireEnterpriseApiKey(req, res, () => {}) === undefined && res.headersSent) return;
    const { voter, support, weight } = req.body || {};
    if (!voter || !ethers.isAddress(voter)) return res.status(400).json({ error: "invalid voter" });
    const votes = store.get("governanceVotes");
    const rec = { id: makeId("vote"), proposalId: req.params.id, voter: voter.toLowerCase(), support: !!support, weight: String(weight || "0"), createdAt: nowTs() };
    votes.push(rec);
    store.set("governanceVotes", votes);
    appendAudit(store, "governance_vote_cast", { proposalId: rec.proposalId, voter: rec.voter, support: rec.support });
    res.json(rec);
  });

  router.get("/governance/overview", (req, res) => {
    if (requireEnterpriseApiKey(req, res, () => {}) === undefined && res.headersSent) return;
    const proposals = store.get("governanceProposals");
    const votes = store.get("governanceVotes");
    const yesWeight = votes.filter((v) => v.support).reduce((a, v) => a + BigInt(v.weight), 0n);
    const noWeight = votes.filter((v) => !v.support).reduce((a, v) => a + BigInt(v.weight), 0n);
    res.json({
      proposals: proposals.length,
      votes: votes.length,
      yesWeight: yesWeight.toString(),
      noWeight: noWeight.toString(),
      stakingAprBps: "1200",
      monthlyEmission: "50000000000000000000000",
    });
  });

  router.get("/tokenomics/metrics", (req, res) => {
    if (requireEnterpriseApiKey(req, res, () => {}) === undefined && res.headersSent) return;
    const votes = store.get("governanceVotes");
    const proposals = store.get("governanceProposals");
    const slashes = store.get("auditEvents").filter((e) => e.type === "relayer_slashed").length;
    res.json({
      totalProposals: proposals.length,
      totalVotes: votes.length,
      totalSlashes: slashes,
      stakingAprBps: "1200",
      relayerRewardPerEpoch: "25000000000000000000",
      treasuryBalance: "1000000000000000000000000",
      circulatingSupply: "50000000000000000000000000",
      updatedAt: nowTs(),
    });
  });

  router.get("/audit/events", (req, res) => {
    if (requireEnterpriseApiKey(req, res, () => {}) === undefined && res.headersSent) return;
    res.json(store.get("auditEvents").slice(-500).reverse());
  });

  return router;
}

module.exports = { createEnterpriseRouter };

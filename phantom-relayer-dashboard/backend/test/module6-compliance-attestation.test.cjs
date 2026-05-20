const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const express = require("express");
const { ethers } = require("ethers");
const {
  initDb,
  saveInternalOrder,
  saveMatch,
  saveFill,
  listComplianceDecisionsByMatch,
  listAttestationDecisionsByMatch,
} = require("../src/db");
const { createComplianceEngine, COMPLIANCE_ACTION } = require("../src/complianceEngine");
const { createSettlementCoordinator } = require("../src/settlementCoordinator");
const { createInternalOrderRouter, INTERNAL_ORDER_TYPES } = require("../src/internalOrderRoutes");

process.env.NOTES_ENCRYPTION_KEY_HEX = process.env.NOTES_ENCRYPTION_KEY_HEX || "22".repeat(32);

function mkDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phantom-m6-"));
  const db = initDb(path.join(dir, "relayer.db"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return db;
}

function makeOrder(id, owner, nonce = "1") {
  const now = Date.now();
  return {
    id,
    ownerAddress: owner.toLowerCase(),
    signingKey: owner.toLowerCase(),
    pairBase: "BUSD",
    pairQuote: "WBNB",
    side: "sell",
    status: "open",
    amount: "1000000000000000000",
    limitPrice: "100",
    remainingAmount: "1000000000000000000",
    filledAmount: "0",
    reservedAmount: "0",
    nonce,
    replayKey: ethers.keccak256(ethers.toUtf8Bytes(`${id}:replay`)),
    signatureHash: `sig-${id}`,
    expiryTs: Math.floor(now / 1000) + 3600,
    encryptedPayload: `enc-${id}`,
    normalizedPayload: { owner, nonce },
    matchRef: null,
    createdBy: owner.toLowerCase(),
    updatedBy: owner.toLowerCase(),
    createdAt: now,
    updatedAt: now,
  };
}

function seedMatch(db, { takerOrderId, makerOrderId, metadataJson }) {
  const matchHash = ethers.keccak256(ethers.toUtf8Bytes(`m6:${Math.random()}`));
  const executionKey = ethers.keccak256(ethers.toUtf8Bytes(`exec:${matchHash}`));
  const matchId = `m-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
  const now = Date.now();
  saveMatch(db, {
    id: matchId,
    matchHash,
    executionKey,
    pairBase: "BUSD",
    pairQuote: "WBNB",
    makerOrderId,
    takerOrderId,
    makerSide: "sell",
    takerSide: "buy",
    executionPrice: "10",
    quantity: "1000000000000000000",
    status: "finalized",
    decisionReasonCode: "FHE_ACCEPTED",
    fheResultHash: "0x" + "11".repeat(32),
    fheDecisionHash: "0x" + "22".repeat(32),
    fheAttestationRef: "att:m6",
    metadataJson,
    createdAt: now,
  });
  saveFill(db, {
    id: `f1-${matchId}`,
    matchId,
    orderId: makerOrderId,
    side: "sell",
    quantity: "1000000000000000000",
    price: "10",
    isMaker: true,
    createdAt: now,
  });
  saveFill(db, {
    id: `f2-${matchId}`,
    matchId,
    orderId: takerOrderId,
    side: "buy",
    quantity: "1000000000000000000",
    price: "10",
    isMaker: false,
    createdAt: now,
  });
  return { matchHash, executionKey };
}

test("module6 intake compliance block denies internal intent", async (t) => {
  const db = mkDb(t);
  const wallet = ethers.Wallet.createRandom();
  const blockedAddr = wallet.address.toLowerCase();
  const complianceEngine = createComplianceEngine({
    db,
    screeningProvider: async ({ actorRef }) => ({
      action: actorRef === blockedAddr ? COMPLIANCE_ACTION.BLOCK_CANCEL : COMPLIANCE_ACTION.ALLOW,
      reasonCode: actorRef === blockedAddr ? "TEST_BLOCK" : "TEST_ALLOW",
      evidenceRef: "test:intake",
      providerResponse: { actorRef },
    }),
  });
  const app = express();
  app.use(express.json());
  app.use("/intent/internal", createInternalOrderRouter({
    db,
    chainId: 97,
    verifyingContract: "0x0000000000000000000000000000000000000001",
    complianceEngine,
  }));
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const intent = {
    owner: blockedAddr,
    signingKey: blockedAddr,
    baseAsset: "BUSD",
    quoteAsset: "WBNB",
    side: "sell",
    amount: "1000000000000000000",
    limitPrice: "100",
    expiry: String(Math.floor(Date.now() / 1000) + 3600),
    nonce: "7",
    replayKey: "0x" + "44".repeat(32),
  };
  const sig = await wallet.signTypedData(
    { name: "PhantomInternalOrder", version: "1", chainId: 97, verifyingContract: "0x0000000000000000000000000000000000000001" },
    INTERNAL_ORDER_TYPES,
    {
      ...intent,
      amount: BigInt(intent.amount),
      limitPrice: BigInt(intent.limitPrice),
      expiry: BigInt(intent.expiry),
      nonce: BigInt(intent.nonce),
    }
  );
  const res = await fetch(`${base}/intent/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent, signature: sig }),
  });
  assert.equal(res.status, 409);
  const out = await res.json();
  assert.equal(out.error, "compliance_intake_blocked");
});

test("module6 execution drift intake-allow then execution-block is auditable", async (t) => {
  const db = mkDb(t);
  const ownerA = ethers.Wallet.createRandom().address;
  const ownerB = ethers.Wallet.createRandom().address;
  const orderA = makeOrder("0x" + "aa".repeat(32), ownerA, "1");
  const orderB = makeOrder("0x" + "bb".repeat(32), ownerB, "2");
  saveInternalOrder(db, orderA);
  saveInternalOrder(db, orderB);
  const onchainData = {
    internalMatchData: {
      takerProof: { a: "0x", b: "0x", c: "0x" },
      takerInputs: {
        nullifier: "0x" + "11".repeat(32),
        inputCommitment: "0x" + "12".repeat(32),
        outputCommitmentSwap: "0x" + "13".repeat(32),
        outputCommitmentChange: "0x" + "14".repeat(32),
        merkleRoot: "0x" + "15".repeat(32),
        inputAssetID: "0",
        outputAssetIDSwap: "1",
        outputAssetIDChange: "0",
        inputAmount: "1000000000000000000",
        swapAmount: "400000000000000000",
        changeAmount: "598000000000000000",
        outputAmountSwap: "400000000000000000",
        minOutputAmountSwap: "390000000000000000",
        gasRefund: "0",
        protocolFee: "2000000000000000",
        merklePath: Array(10).fill("0"),
        merklePathIndices: Array(10).fill("0"),
      },
      makerProof: { a: "0x", b: "0x", c: "0x" },
      makerInputs: {
        nullifier: "0x" + "21".repeat(32),
        inputCommitment: "0x" + "22".repeat(32),
        outputCommitmentSwap: "0x" + "23".repeat(32),
        outputCommitmentChange: "0x" + "24".repeat(32),
        merkleRoot: "0x" + "15".repeat(32),
        inputAssetID: "1",
        outputAssetIDSwap: "0",
        outputAssetIDChange: "1",
        inputAmount: "1000000000000000000",
        swapAmount: "400000000000000000",
        changeAmount: "598000000000000000",
        outputAmountSwap: "400000000000000000",
        minOutputAmountSwap: "390000000000000000",
        gasRefund: "0",
        protocolFee: "2000000000000000",
        merklePath: Array(10).fill("0"),
        merklePathIndices: Array(10).fill("0"),
      },
      encryptedPayload: "0x",
    },
  };
  const { matchHash } = seedMatch(db, {
    takerOrderId: orderA.id,
    makerOrderId: orderB.id,
    metadataJson: {
      noteRefs: [{ noteId: "n1" }],
      witness: { merkleRoot: "0x" + "15".repeat(32) },
      changeAmount: "0",
      onchain: onchainData,
    },
  });

  let phase = "intake";
  const complianceEngine = createComplianceEngine({
    db,
    screeningProvider: async ({ actorRef }) => {
      if (phase === "intake") {
        return { action: COMPLIANCE_ACTION.ALLOW, reasonCode: "ALLOW_INTAKE", providerResponse: { actorRef, phase } };
      }
      if (String(actorRef).toLowerCase() === ownerB.toLowerCase()) {
        return { action: COMPLIANCE_ACTION.BLOCK_CANCEL, reasonCode: "EXEC_BLOCK", providerResponse: { actorRef, phase } };
      }
      return { action: COMPLIANCE_ACTION.ALLOW, reasonCode: "ALLOW_EXEC", providerResponse: { actorRef, phase } };
    },
  });
  const coordinator = createSettlementCoordinator({
    db,
    complianceEngine,
    submitter: async () => ({ txHash: "0x" + "ab".repeat(32), receipt: { blockNumber: 1, status: 1, gasUsed: "1" } }),
  });
  phase = "execution";
  const out = await coordinator.start(matchHash, { policy: { submissionMode: "dry_run" } });
  assert.equal(out.decisionReasonCode, "COMPLIANCE_BLOCKED");
  assert.equal(out.txHash, null);
  const decisions = listComplianceDecisionsByMatch(db, matchHash, 20);
  assert.ok(decisions.length >= 2);
});

test("module6 attestation gate: missing/invalid/quorum/valid cases", async (t) => {
  const db = mkDb(t);
  const ownerA = ethers.Wallet.createRandom().address;
  const ownerB = ethers.Wallet.createRandom().address;
  const orderA = makeOrder("0x" + "cc".repeat(32), ownerA, "3");
  const orderB = makeOrder("0x" + "dd".repeat(32), ownerB, "4");
  saveInternalOrder(db, orderA);
  saveInternalOrder(db, orderB);

  const baseOnchain = {
    internalMatchData: {
      takerProof: { a: "0x", b: "0x", c: "0x" },
      takerInputs: {
        nullifier: "0x" + "31".repeat(32),
        inputCommitment: "0x" + "32".repeat(32),
        outputCommitmentSwap: "0x" + "33".repeat(32),
        outputCommitmentChange: "0x" + "34".repeat(32),
        merkleRoot: "0x" + "35".repeat(32),
        inputAssetID: "0",
        outputAssetIDSwap: "1",
        outputAssetIDChange: "0",
        inputAmount: "1000000000000000000",
        swapAmount: "400000000000000000",
        changeAmount: "598000000000000000",
        outputAmountSwap: "400000000000000000",
        minOutputAmountSwap: "390000000000000000",
        gasRefund: "0",
        protocolFee: "2000000000000000",
        merklePath: Array(10).fill("0"),
        merklePathIndices: Array(10).fill("0"),
      },
      makerProof: { a: "0x", b: "0x", c: "0x" },
      makerInputs: {
        nullifier: "0x" + "41".repeat(32),
        inputCommitment: "0x" + "42".repeat(32),
        outputCommitmentSwap: "0x" + "43".repeat(32),
        outputCommitmentChange: "0x" + "44".repeat(32),
        merkleRoot: "0x" + "35".repeat(32),
        inputAssetID: "1",
        outputAssetIDSwap: "0",
        outputAssetIDChange: "1",
        inputAmount: "1000000000000000000",
        swapAmount: "400000000000000000",
        changeAmount: "598000000000000000",
        outputAmountSwap: "400000000000000000",
        minOutputAmountSwap: "390000000000000000",
        gasRefund: "0",
        protocolFee: "2000000000000000",
        merklePath: Array(10).fill("0"),
        merklePathIndices: Array(10).fill("0"),
      },
      encryptedPayload: "0x",
    },
  };
  const { matchHash } = seedMatch(db, {
    takerOrderId: orderA.id,
    makerOrderId: orderB.id,
    metadataJson: {
      noteRefs: [{ noteId: "n1" }],
      witness: { merkleRoot: "0x" + "35".repeat(32) },
      changeAmount: "0",
      onchain: baseOnchain,
    },
  });
  const complianceEngine = createComplianceEngine({
    db,
    screeningProvider: async () => ({ action: COMPLIANCE_ACTION.ALLOW, reasonCode: "ALLOW", providerResponse: {} }),
  });
  const verdictByMatch = new Map();
  const validatorNetwork = {
    verifyAttestationQuorum: async (_att, binding, opts) => {
      const preset = verdictByMatch.get(binding.matchHash);
      if (preset) {
        return {
          requiredQuorumBps: opts.requiredQuorumBps,
          signerCount: 0,
          signerSetHash: null,
          ...preset,
        };
      }
      return {
        valid: false,
        reasonCode: "ATTESTATION_MISSING",
        requiredQuorumBps: opts.requiredQuorumBps,
        signerCount: 0,
        signerSetHash: null,
      };
    },
  };
  const coordinator = createSettlementCoordinator({
    db,
    complianceEngine,
    validatorNetwork,
    submitter: async () => ({ txHash: "0x" + "ef".repeat(32), receipt: { blockNumber: 9, status: 1, gasUsed: "9" } }),
  });

  verdictByMatch.set(matchHash, { valid: false, reasonCode: "ATTESTATION_MISSING" });
  const missing = await coordinator.start(matchHash, {
    policy: { submissionMode: "dry_run", requireAttestation: true, compliancePolicyVersion: "v1" },
  });
  assert.equal(missing.decisionReasonCode, "ATTESTATION_MISSING");

  const withInvalidAtt = seedMatch(db, {
    takerOrderId: orderA.id,
    makerOrderId: orderB.id,
    metadataJson: {
      noteRefs: [{ noteId: "n1" }],
      witness: { merkleRoot: "0x" + "35".repeat(32) },
      changeAmount: "0",
      onchain: baseOnchain,
    },
  });
  verdictByMatch.set(withInvalidAtt.matchHash, { valid: false, reasonCode: "ATTESTATION_INVALID" });
  const invalid = await coordinator.start(withInvalidAtt.matchHash, {
    policy: { submissionMode: "dry_run", requireAttestation: true, compliancePolicyVersion: "v1" },
  });
  assert.equal(invalid.decisionReasonCode, "ATTESTATION_INVALID");

  const withLowQuorum = seedMatch(db, {
    takerOrderId: orderA.id,
    makerOrderId: orderB.id,
    metadataJson: {
      noteRefs: [{ noteId: "n1" }],
      witness: { merkleRoot: "0x" + "35".repeat(32) },
      changeAmount: "0",
      onchain: baseOnchain,
    },
  });
  verdictByMatch.set(withLowQuorum.matchHash, { valid: false, reasonCode: "ATTESTATION_QUORUM_INSUFFICIENT", signerCount: 1 });
  const insufficient = await coordinator.start(withLowQuorum.matchHash, {
    policy: { submissionMode: "dry_run", requireAttestation: true, compliancePolicyVersion: "v1", attestationQuorumBps: 6600 },
  });
  assert.equal(insufficient.decisionReasonCode, "ATTESTATION_QUORUM_INSUFFICIENT");

  const withGoodQuorum = seedMatch(db, {
    takerOrderId: orderA.id,
    makerOrderId: orderB.id,
    metadataJson: {
      noteRefs: [{ noteId: "n1" }],
      witness: { merkleRoot: "0x" + "35".repeat(32) },
      changeAmount: "0",
      onchain: baseOnchain,
    },
  });
  verdictByMatch.set(withGoodQuorum.matchHash, { valid: true, reasonCode: null, signerCount: 2 });
  const allowed = await coordinator.start(withGoodQuorum.matchHash, {
    policy: { submissionMode: "dry_run", requireAttestation: true, compliancePolicyVersion: "v1", attestationQuorumBps: 6600 },
  });
  assert.equal(allowed.settlementStatus, "submitted");
  const attRows = listAttestationDecisionsByMatch(db, withGoodQuorum.matchHash, 20);
  assert.ok(attRows.length >= 1);
});

test("module6 SEE middleware protects internal sensitive routes", async () => {
  const prev = {
    SEE_MODE: process.env.SEE_MODE,
    SEE_SHARED_SECRET: process.env.SEE_SHARED_SECRET,
  };
  process.env.SEE_MODE = "enforced";
  process.env.SEE_SHARED_SECRET = "unit-test-see-secret";
  delete require.cache[require.resolve("../src/seeGuard")];
  const { requireSeeForSensitiveFlow } = require("../src/seeGuard");
  const app = express();
  app.use(express.json());
  app.post("/intent/internal/mock", requireSeeForSensitiveFlow, (_req, res) => res.json({ ok: true }));
  app.post("/fhe/internal/mock", requireSeeForSensitiveFlow, (_req, res) => res.json({ ok: true }));
  // Path-B: SEE guard still protects internal-match status reads.
  app.get("/internal-match/0x" + "11".repeat(32) + "/status", requireSeeForSensitiveFlow, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const a = await fetch(`${base}/intent/internal/mock`, { method: "POST" });
  const b = await fetch(`${base}/fhe/internal/mock`, { method: "POST" });
  const c = await fetch(`${base}/internal-match/0x${"11".repeat(32)}/status`);
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(c.status, 401);
  server.close();
  process.env.SEE_MODE = prev.SEE_MODE;
  process.env.SEE_SHARED_SECRET = prev.SEE_SHARED_SECRET;
});

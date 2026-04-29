const path = require("path");
const os = require("os");
const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { initDb, saveMatch, saveFill } = require("../src/db");
const { createSettlementCoordinator, PRECHECK_REASON, SETTLEMENT_STATUS } = require("../src/settlementCoordinator");

function withDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phantom-m4-"));
  const db = initDb(path.join(dir, "relayer.db"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return db;
}

function seedMatch(db, overrides = {}) {
  const matchHash = overrides.matchHash || ethers.keccak256(ethers.toUtf8Bytes(`m4:${Math.random()}`));
  const matchId = overrides.id || cryptoRandomId();
  const executionKey = overrides.executionKey || ethers.keccak256(ethers.toUtf8Bytes(`exec:${matchHash}`));
  const makerOrderId = "0x" + "11".repeat(32);
  const takerOrderId = "0x" + "22".repeat(32);
  const decisionArtifact = buildDecisionArtifact({
    matchHash,
    executionKey,
    makerOrderId,
    takerOrderId,
    pairBase: "BUSD",
    pairQuote: "WBNB",
    makerSide: "sell",
    takerSide: "buy",
    fheResultHash: overrides.fheResultHash || "0x" + "33".repeat(32),
  });
  const baseMetadata = {
    noteRefs: [{ noteId: "n1" }],
    witness: { merkleRoot: "0x" + "55".repeat(32) },
    changeAmount: "0",
    decisionArtifact,
  };
  const metadataJson = overrides.metadataJson
    ? {
        ...overrides.metadataJson,
        decisionArtifact:
          overrides.metadataJson.decisionArtifact === undefined
            ? decisionArtifact
            : overrides.metadataJson.decisionArtifact,
      }
    : baseMetadata;
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
    quantity: overrides.quantity || "100",
    status: "finalized",
    decisionReasonCode: "FHE_ACCEPTED",
    fheResultHash: overrides.fheResultHash || "0x" + "33".repeat(32),
    fheDecisionHash: overrides.fheDecisionHash || hashDecisionArtifact(decisionArtifact),
    fheAttestationRef: "att:1",
    metadataJson,
    createdAt: Date.now(),
  });
  saveFill(db, {
    id: cryptoRandomId(),
    matchId,
    orderId: "0x" + "11".repeat(32),
    side: "sell",
    quantity: overrides.quantity || "100",
    price: "10",
    isMaker: true,
    createdAt: Date.now(),
  });
  saveFill(db, {
    id: cryptoRandomId(),
    matchId,
    orderId: "0x" + "22".repeat(32),
    side: "buy",
    quantity: overrides.quantity || "100",
    price: "10",
    isMaker: false,
    createdAt: Date.now(),
  });
  return { matchHash, executionKey };
}

function cryptoRandomId() {
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashDecisionArtifact(artifact) {
  return ethers.keccak256(ethers.toUtf8Bytes(stableStringify(artifact || {})));
}

function buildDecisionArtifact({
  matchHash,
  executionKey,
  makerOrderId,
  takerOrderId,
  pairBase,
  pairQuote,
  makerSide,
  takerSide,
  fheResultHash,
}) {
  return {
    schema: "phantom.match.decision.v1",
    domain: {
      protocol: "phantom-internal-matching",
      chainId: 97,
      verifyingContract: ethers.ZeroAddress,
      engine: "test",
      engineMode: "remote",
      decisionDomain: "default",
    },
    orders: {
      taker: { orderId: takerOrderId, side: takerSide, pairBase, pairQuote, nonce: "0", replayKey: "0x" + "aa".repeat(32) },
      maker: { orderId: makerOrderId, side: makerSide, pairBase, pairQuote, nonce: "0", replayKey: "0x" + "bb".repeat(32) },
    },
    constraints: { pair: `${pairBase}/${pairQuote}`, takerSide, makerSide, priceCompatible: true, policyMode: "strict", degradedAllowUnavailable: false },
    timing: { traceId: "test-trace", decidedAtMs: Date.now(), decisionNonce: "test-nonce" },
    result: { decision: "match_approved", reasonCode: "FHE_ACCEPTED", fheResultHash },
    attestation: { reference: "att:1", signature: "sig:test", payloadHash: "0x" + "cc".repeat(32) },
    bindings: { matchHash, executionKey },
  };
}

test("module4 conservation and fee math precheck passes coherent payload", async (t) => {
  const db = withDb(t);
  const { matchHash } = seedMatch(db, { quantity: "100" });
  const coordinator = createSettlementCoordinator({ db });
  const status = await coordinator.start(matchHash, {
    policy: { protocolFeeBps: 100, gasRefundWei: "0", submissionMode: "dry_run" },
  });
  assert.equal(status.settlementStatus, SETTLEMENT_STATUS.SUBMITTED);
  const out = coordinator.getStatus(matchHash);
  assert.ok(out.execution.payloadJson);
  const p = out.execution.payloadJson;
  assert.equal(
    BigInt(p.amounts.inputAmount).toString(),
    (BigInt(p.amounts.matchedOut) + BigInt(p.amounts.changeAmount) + BigInt(p.amounts.protocolFee) + BigInt(p.amounts.gasRefund)).toString()
  );
});

test("module4 precheck failure taxonomy persists without corrupting match/fill", async (t) => {
  const db = withDb(t);
  const { matchHash } = seedMatch(db, {
    metadataJson: {
      noteRefs: [],
      witness: null,
      changeAmount: "0",
    },
  });
  const coordinator = createSettlementCoordinator({ db });
  const out = await coordinator.start(matchHash, {
    policy: { allowFallback: false, fallbackMode: "none" },
  });
  assert.equal(out.settlementStatus, SETTLEMENT_STATUS.FAILED);
  assert.equal(out.decisionReasonCode, PRECHECK_REASON.MISSING_NOTE_REFERENCES);
  const status = coordinator.getStatus(matchHash);
  assert.ok(status.events.some((e) => e.reasonCode === PRECHECK_REASON.MISSING_NOTE_REFERENCES));
});

test("module4 idempotent re-trigger returns already submitted without duplicate submit", async (t) => {
  const db = withDb(t);
  const { matchHash } = seedMatch(db, {});
  let submits = 0;
  const coordinator = createSettlementCoordinator({
    db,
    submitter: ({ payload }) => {
      submits += 1;
      return { txHash: ethers.keccak256(ethers.toUtf8Bytes(payload.matchHash)) };
    },
  });
  const first = await coordinator.start(matchHash, { policy: { submissionMode: "live" } });
  const second = await coordinator.start(matchHash, { policy: { submissionMode: "live" } });
  assert.equal(first.settlementStatus, SETTLEMENT_STATUS.SUBMITTED);
  assert.equal(second.idempotent, true);
  assert.equal(submits, 1);
});

test("module4 transient failure -> retriable then explicit retry succeeds", async (t) => {
  const db = withDb(t);
  const { matchHash } = seedMatch(db, {});
  let calls = 0;
  const coordinator = createSettlementCoordinator({
    db,
    submitter: ({ payload }) => {
      calls += 1;
      if (calls === 1) throw new Error("network timeout");
      return { txHash: ethers.keccak256(ethers.toUtf8Bytes(`${payload.matchHash}:ok`)) };
    },
  });
  const first = await coordinator.start(matchHash, { policy: { submissionMode: "live" } });
  assert.equal(first.settlementStatus, SETTLEMENT_STATUS.RETRIABLE);
  assert.equal(first.decisionReasonCode, PRECHECK_REASON.SUBMIT_TRANSIENT_ERROR);
  const second = await coordinator.retry(matchHash, { policy: { submissionMode: "live" } });
  assert.equal(second.settlementStatus, SETTLEMENT_STATUS.SUBMITTED);
});

test("module4 explicit fallback enabled routes deterministically and persists reason", async (t) => {
  const db = withDb(t);
  const { matchHash } = seedMatch(db, {
    metadataJson: {
      noteRefs: [],
      witness: null,
      changeAmount: "0",
    },
  });
  const coordinator = createSettlementCoordinator({ db });
  const out = await coordinator.start(matchHash, {
    policy: { allowFallback: true, fallbackMode: "shieldedSwapJoinSplit" },
  });
  assert.equal(out.settlementStatus, SETTLEMENT_STATUS.RETRIABLE);
  assert.equal(out.decisionReasonCode, PRECHECK_REASON.FALLBACK_ROUTED);
  const status = coordinator.getStatus(matchHash);
  assert.ok(status.execution.fallbackMode === "shieldedSwapJoinSplit");
  assert.ok(status.events.some((e) => e.eventType === "settlement_fallback_routed"));
});

test("module4 settlement rejects missing decision artifact", async (t) => {
  const db = withDb(t);
  const { matchHash } = seedMatch(db, {
    metadataJson: {
      noteRefs: [{ noteId: "n1" }],
      witness: { merkleRoot: "0x" + "55".repeat(32) },
      changeAmount: "0",
      decisionArtifact: null,
    },
    fheDecisionHash: "0x" + "44".repeat(32),
  });
  const coordinator = createSettlementCoordinator({ db });
  const out = await coordinator.start(matchHash, { policy: { submissionMode: "dry_run" } });
  assert.equal(out.settlementStatus, SETTLEMENT_STATUS.FAILED);
  assert.equal(out.decisionReasonCode, PRECHECK_REASON.DECISION_ARTIFACT_MISSING);
});

test("module4 settlement rejects invalid decision artifact hash", async (t) => {
  const db = withDb(t);
  const { matchHash } = seedMatch(db, {
    fheDecisionHash: "0x" + "ff".repeat(32),
  });
  const coordinator = createSettlementCoordinator({ db });
  const out = await coordinator.start(matchHash, { policy: { submissionMode: "dry_run" } });
  assert.equal(out.settlementStatus, SETTLEMENT_STATUS.FAILED);
  assert.equal(out.decisionReasonCode, PRECHECK_REASON.DECISION_ARTIFACT_INVALID);
});

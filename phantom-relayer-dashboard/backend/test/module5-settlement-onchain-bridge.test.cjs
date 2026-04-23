const path = require("path");
const os = require("os");
const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { initDb, saveMatch, saveFill } = require("../src/db");
const { createSettlementCoordinator, SETTLEMENT_STATUS } = require("../src/settlementCoordinator");

function withDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phantom-m5-"));
  const db = initDb(path.join(dir, "relayer.db"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return db;
}

function seedOnchainMatch(db) {
  const matchHash = ethers.keccak256(ethers.toUtf8Bytes(`m5:${Math.random()}`));
  const executionKey = ethers.keccak256(ethers.toUtf8Bytes(`exec:${matchHash}`));
  const matchId = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  const now = Date.now();
  const pi = {
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
  };
  saveMatch(db, {
    id: matchId,
    matchHash,
    executionKey,
    pairBase: "BUSD",
    pairQuote: "WBNB",
    makerOrderId: "0x" + "aa".repeat(32),
    takerOrderId: "0x" + "bb".repeat(32),
    makerSide: "sell",
    takerSide: "buy",
    executionPrice: "10",
    quantity: "1000000000000000000",
    status: "finalized",
    decisionReasonCode: "FHE_ACCEPTED",
    fheResultHash: "0x" + "22".repeat(32),
    fheDecisionHash: "0x" + "23".repeat(32),
    fheAttestationRef: "att:m5",
    metadataJson: {
      noteRefs: [{ noteId: "n1" }, { noteId: "n2" }],
      witness: { merkleRoot: pi.merkleRoot },
      changeAmount: "0",
      onchain: {
        internalMatchData: {
          takerProof: { a: "0x", b: "0x", c: "0x" },
          takerInputs: pi,
          makerProof: { a: "0x", b: "0x", c: "0x" },
          makerInputs: {
            ...pi,
            nullifier: "0x" + "21".repeat(32),
            inputCommitment: "0x" + "22".repeat(32),
            outputCommitmentSwap: "0x" + "23".repeat(32),
            outputCommitmentChange: "0x" + "24".repeat(32),
            inputAssetID: "1",
            outputAssetIDSwap: "0",
          },
          matchHash,
          executionKey,
          encryptedPayload: "0x",
        },
      },
    },
    createdAt: now,
  });
  saveFill(db, {
    id: `f1-${matchId}`,
    matchId,
    orderId: "0x" + "aa".repeat(32),
    side: "sell",
    quantity: "1000000000000000000",
    price: "10",
    isMaker: true,
    createdAt: now,
  });
  saveFill(db, {
    id: `f2-${matchId}`,
    matchId,
    orderId: "0x" + "bb".repeat(32),
    side: "buy",
    quantity: "1000000000000000000",
    price: "10",
    isMaker: false,
    createdAt: now,
  });
  return { matchHash };
}

test("module5 coordinator persists tx receipt fields in execution journal", async (t) => {
  const db = withDb(t);
  const { matchHash } = seedOnchainMatch(db);
  const coordinator = createSettlementCoordinator({
    db,
    submitter: async () => ({
      txHash: "0x" + "ab".repeat(32),
      receipt: { blockNumber: 123, status: 1, gasUsed: "250000" },
      mode: "live_internal_match",
    }),
  });
  const out = await coordinator.start(matchHash, { policy: { submissionMode: "live_internal_match" } });
  assert.equal(out.settlementStatus, SETTLEMENT_STATUS.SUBMITTED);
  assert.equal(out.txHash, "0x" + "ab".repeat(32));
  const status = coordinator.getStatus(matchHash);
  assert.equal(status.execution.payloadJson.onchainResult.blockNumber, 123);
  assert.equal(status.execution.payloadJson.onchainResult.status, 1);
});

test("module5 coordinator idempotency avoids duplicate live submits", async (t) => {
  const db = withDb(t);
  const { matchHash } = seedOnchainMatch(db);
  let calls = 0;
  const coordinator = createSettlementCoordinator({
    db,
    submitter: async () => {
      calls += 1;
      return { txHash: "0x" + "cd".repeat(32), receipt: { blockNumber: 2, status: 1, gasUsed: "1" } };
    },
  });
  const a = await coordinator.start(matchHash, { policy: { submissionMode: "live_internal_match" } });
  const b = await coordinator.start(matchHash, { policy: { submissionMode: "live_internal_match" } });
  assert.equal(a.settlementStatus, SETTLEMENT_STATUS.SUBMITTED);
  assert.equal(b.idempotent, true);
  assert.equal(calls, 1);
});

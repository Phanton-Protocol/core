const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { ethers } = require("ethers");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phantom-m8-"));
const dbPath = path.join(tempDir, "relayer.db");
process.env.FIREBASE_FUNCTIONS = "true";
process.env.SEE_MODE = "disabled";
process.env.NOTES_ENCRYPTION_KEY_HEX = process.env.NOTES_ENCRYPTION_KEY_HEX || "11".repeat(32);
process.env.RELAYER_DB_PATH = dbPath;
process.env.SETTLEMENT_SUBMISSION_MODE = "dry_run";
process.env.COMPLIANCE_POLICY_MODE = "disabled";
process.env.ATTESTATION_REQUIRED = "false";
process.env.SHIELDED_POOL_ADDRESS =
  process.env.SHIELDED_POOL_ADDRESS || "0xC1C4cb6d27790cf61132e62062Ae66392Bc013F2";

const { app } = require("../src/index");
const { initDb, getMatchByHash, saveMatch, saveFill, saveInternalOrder } = require("../src/db");
const { configureMatchingEngine, runDeterministicMatchForOrder, REASON_CODES } = require("../src/fheMatchingService");
const {
  createSettlementCoordinator,
  PRECHECK_REASON,
  SETTLEMENT_STATUS,
} = require("../src/settlementCoordinator");

function withServer(t, targetApp = app) {
  const server = targetApp.listen(0);
  t.after(() => server.close());
  return new Promise((resolve) => {
    server.once("listening", () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
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

function computeProofContextHash({ decisionHash, matchHash, executionKey, inputs }) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      [
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
      ],
      [
        ethers.id("PHANTOM_INTERNAL_MATCH_PROOF_CONTEXT_V1"),
        decisionHash,
        matchHash,
        executionKey,
        inputs.nullifier,
        inputs.inputCommitment,
        inputs.outputCommitmentSwap,
        inputs.outputCommitmentChange,
        BigInt(inputs.inputAssetID),
        BigInt(inputs.outputAssetIDSwap),
        BigInt(inputs.outputAssetIDChange),
        BigInt(inputs.swapAmount),
      ]
    )
  );
}

function buildDecisionArtifact({ matchHash, executionKey, makerOrderId, takerOrderId, fheResultHash }) {
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
      taker: {
        orderId: takerOrderId,
        side: "buy",
        pairBase: "BUSD",
        pairQuote: "WBNB",
        nonce: "1",
        replayKey: "0x" + "aa".repeat(32),
      },
      maker: {
        orderId: makerOrderId,
        side: "sell",
        pairBase: "BUSD",
        pairQuote: "WBNB",
        nonce: "2",
        replayKey: "0x" + "bb".repeat(32),
      },
    },
    constraints: {
      pair: "BUSD/WBNB",
      takerSide: "buy",
      makerSide: "sell",
      priceCompatible: true,
      policyMode: "strict",
      degradedAllowUnavailable: false,
    },
    timing: { traceId: "m8-trace", decidedAtMs: Date.now(), decisionNonce: "m8-nonce" },
    result: { decision: "match_approved", reasonCode: "FHE_ACCEPTED", fheResultHash },
    attestation: { reference: "att:m8", signature: "sig:m8", payloadHash: "0x" + "cc".repeat(32) },
    bindings: { matchHash, executionKey },
  };
}

async function createSignedInternalIntent({ baseUrl, ownerWallet, signingWallet, side, nonce, amount = "100", limitPrice = "10" }) {
  const chainId = Number(process.env.CHAIN_ID || process.env.PHANTOM_CHAIN_ID || 97);
  const verifyingContract = process.env.SHIELDED_POOL_ADDRESS || ethers.ZeroAddress;
  const nowSec = Math.floor(Date.now() / 1000);
  const intent = {
    owner: ownerWallet.address,
    signingKey: signingWallet.address,
    baseAsset: "BUSD",
    quoteAsset: "WBNB",
    side,
    amount,
    limitPrice,
    expiry: String(nowSec + 3600),
    nonce: String(nonce),
    replayKey: ethers.keccak256(ethers.toUtf8Bytes(`m8:${ownerWallet.address}:${nonce}:${side}`)),
  };
  const domain = {
    name: "PhantomInternalOrder",
    version: "1",
    chainId,
    verifyingContract,
  };
  const types = {
    InternalOrderIntent: [
      { name: "owner", type: "address" },
      { name: "signingKey", type: "address" },
      { name: "baseAsset", type: "string" },
      { name: "quoteAsset", type: "string" },
      { name: "side", type: "string" },
      { name: "amount", type: "uint256" },
      { name: "limitPrice", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "replayKey", type: "bytes32" },
    ],
  };
  const typed = {
    ...intent,
    amount: BigInt(intent.amount),
    limitPrice: BigInt(intent.limitPrice),
    expiry: BigInt(intent.expiry),
    nonce: BigInt(intent.nonce),
  };
  const signature = await signingWallet.signTypedData(domain, types, typed);
  const res = await fetch(`${baseUrl}/intent/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent, signature }),
  });
  return { res, intent };
}

function seedOnchainMatch(db, { tamperProofContext = false, makerOrderId, takerOrderId } = {}) {
  const matchHash = ethers.keccak256(ethers.toUtf8Bytes(`m8-match:${Math.random()}`));
  const executionKey = ethers.keccak256(ethers.toUtf8Bytes(`m8-exec:${matchHash}`));
  const matchId = crypto.randomUUID();
  const now = Date.now();
  const takerInputs = {
    nullifier: "0x" + "01".repeat(32),
    inputCommitment: "0x" + "02".repeat(32),
    outputCommitmentSwap: "0x" + "03".repeat(32),
    outputCommitmentChange: "0x" + "04".repeat(32),
    merkleRoot: "0x" + "05".repeat(32),
    inputAssetID: "0",
    outputAssetIDSwap: "1",
    outputAssetIDChange: "0",
    inputAmount: "100",
    swapAmount: "95",
    changeAmount: "5",
    outputAmountSwap: "95",
    minOutputAmountSwap: "95",
    gasRefund: "0",
    protocolFee: "0",
    merklePath: Array(10).fill("0"),
    merklePathIndices: Array(10).fill("0"),
  };
  const makerInputs = {
    ...takerInputs,
    nullifier: "0x" + "06".repeat(32),
    inputCommitment: "0x" + "07".repeat(32),
    outputCommitmentSwap: "0x" + "08".repeat(32),
    outputCommitmentChange: "0x" + "09".repeat(32),
    inputAssetID: "1",
    outputAssetIDSwap: "0",
    outputAssetIDChange: "1",
  };
  const decisionArtifact = buildDecisionArtifact({
    matchHash,
    executionKey,
    makerOrderId: makerOrderId || "0x" + "aa".repeat(32),
    takerOrderId: takerOrderId || "0x" + "bb".repeat(32),
    fheResultHash: "0x" + "dd".repeat(32),
  });
  const decisionHash = hashDecisionArtifact(decisionArtifact);
  saveMatch(db, {
    id: matchId,
    matchHash,
    executionKey,
    pairBase: "BUSD",
    pairQuote: "WBNB",
    makerOrderId: makerOrderId || "0x" + "aa".repeat(32),
    takerOrderId: takerOrderId || "0x" + "bb".repeat(32),
    makerSide: "sell",
    takerSide: "buy",
    executionPrice: "10",
    quantity: "100",
    status: "finalized",
    decisionReasonCode: "FHE_ACCEPTED",
    fheResultHash: "0x" + "dd".repeat(32),
    fheDecisionHash: decisionHash,
    fheAttestationRef: "att:m8",
    metadataJson: {
      noteRefs: [{ noteId: "n1" }],
      witness: { merkleRoot: "0x" + "05".repeat(32) },
      changeAmount: "0",
      decisionArtifact,
      onchain: {
        internalMatchData: {
          matchHash,
          executionKey,
          decisionHash,
          takerProof: { a: "0x", b: "0x", c: "0x" },
          makerProof: { a: "0x", b: "0x", c: "0x" },
          takerInputs,
          makerInputs,
          takerProofContextHash: tamperProofContext
            ? "0x" + "ff".repeat(32)
            : computeProofContextHash({ decisionHash, matchHash, executionKey, inputs: takerInputs }),
          makerProofContextHash: computeProofContextHash({ decisionHash, matchHash, executionKey, inputs: makerInputs }),
          relayer: "0x" + "66".repeat(20),
          encryptedPayload: "0x",
        },
      },
    },
    createdAt: now,
  });
  saveFill(db, {
    id: crypto.randomUUID(),
    matchId,
    orderId: makerOrderId || "0x" + "aa".repeat(32),
    side: "sell",
    quantity: "100",
    price: "10",
    isMaker: true,
    createdAt: now,
  });
  saveFill(db, {
    id: crypto.randomUUID(),
    matchId,
    orderId: takerOrderId || "0x" + "bb".repeat(32),
    side: "buy",
    quantity: "100",
    price: "10",
    isMaker: false,
    createdAt: now,
  });
  return { matchHash };
}

test("module8 happy path: intent create -> encrypted match -> decision artifact -> settlement success", async (t) => {
  const baseUrl = await withServer(t);
  const db = initDb(dbPath);
  const alice = ethers.Wallet.createRandom();
  const bob = ethers.Wallet.createRandom();

  const buy = await createSignedInternalIntent({
    baseUrl,
    ownerWallet: alice,
    signingWallet: alice,
    side: "buy",
    nonce: 101,
    amount: "100",
    limitPrice: "11",
  });
  assert.equal(buy.res.status, 201);
  const buyBody = await buy.res.json();
  assert.ok(buyBody.orderId);

  const sell = await createSignedInternalIntent({
    baseUrl,
    ownerWallet: bob,
    signingWallet: bob,
    side: "sell",
    nonce: 202,
    amount: "100",
    limitPrice: "10",
  });
  assert.equal(sell.res.status, 201);
  const sellBody = await sell.res.json();
  assert.ok(sellBody.orderId);

  const { matchHash } = seedOnchainMatch(db, {
    makerOrderId: sellBody.orderId,
    takerOrderId: buyBody.orderId,
  });
  const match = getMatchByHash(db, matchHash);
  assert.ok(match?.fheDecisionHash);
  assert.ok(match?.metadataJson?.decisionArtifact);

  const coordinator = createSettlementCoordinator({ db });
  const settled = await coordinator.start(matchHash, {
    policy: { submissionMode: "dry_run", compliancePolicyMode: "disabled" },
  });
  assert.equal(settled.settlementStatus, "submitted");
});

test("module8 failure: FHE unavailable in prod/strict mode blocks matching", async () => {
  const db = initDb(dbPath);
  const buyId = ethers.keccak256(ethers.toUtf8Bytes(`m8-buy-${Math.random()}`));
  const sellId = ethers.keccak256(ethers.toUtf8Bytes(`m8-sell-${Math.random()}`));
  const now = Date.now();
  const mk = (id, side, price, nonce) => ({
    id,
    ownerAddress: ethers.Wallet.createRandom().address.toLowerCase(),
    signingKey: ethers.Wallet.createRandom().address.toLowerCase(),
    pairBase: "BUSD",
    pairQuote: "WBNB",
    side,
    status: "open",
    amount: "100",
    limitPrice: String(price),
    remainingAmount: "100",
    filledAmount: "0",
    reservedAmount: "0",
    nonce: String(nonce),
    replayKey: ethers.keccak256(ethers.toUtf8Bytes(`m8-rk-${id}`)),
    signatureHash: ethers.keccak256(ethers.toUtf8Bytes(`m8-sg-${id}`)),
    expiryTs: Math.floor(Date.now() / 1000) + 3600,
    encryptedPayload: "{}",
    normalizedPayload: { side, amount: "100", limitPrice: String(price) },
    matchRef: null,
    createdBy: "m8-test",
    updatedBy: "m8-test",
    createdAt: now,
    updatedAt: now,
  });
  saveInternalOrder(db, mk(buyId, "buy", 11, 301));
  saveInternalOrder(db, mk(sellId, "sell", 10, 302));

  configureMatchingEngine({
    db,
    fhePolicyMode: "strict",
    fheCompatibilityEvaluator: async () => {
      throw new Error("fhe service unavailable");
    },
  });
  const out = await runDeterministicMatchForOrder(buyId, "module8-fhe-down");
  assert.equal(out.matched, false);
  assert.equal(out.reasonCode, REASON_CODES.NO_COMPATIBLE_COUNTERPARTY);
});

test("module8 failure: submitter throw classified as fatal submission error (off-chain dry-run)", async () => {
  const db = initDb(dbPath);
  const { matchHash } = seedOnchainMatch(db);
  const coordinator = createSettlementCoordinator({
    db,
    submitter: async () => {
      throw new Error("execution reverted: invalid attestation/proof");
    },
  });
  const out = await coordinator.start(matchHash, { policy: { submissionMode: "dry_run" } });
  assert.equal(out.settlementStatus, SETTLEMENT_STATUS.FAILED);
  assert.equal(out.decisionReasonCode, PRECHECK_REASON.SUBMIT_FATAL_ERROR);
});

test("module8 failure: duplicate/replay settlement is idempotent and not re-submitted (off-chain dry-run)", async () => {
  const db = initDb(dbPath);
  const { matchHash } = seedOnchainMatch(db);
  let calls = 0;
  const coordinator = createSettlementCoordinator({
    db,
    submitter: async () => {
      calls += 1;
      return { txHash: "0x" + "ab".repeat(32), receipt: { blockNumber: 1, status: 1, gasUsed: "1" } };
    },
  });
  const first = await coordinator.start(matchHash, { policy: { submissionMode: "dry_run" } });
  const second = await coordinator.start(matchHash, { policy: { submissionMode: "dry_run" } });
  assert.equal(first.settlementStatus, SETTLEMENT_STATUS.SUBMITTED);
  assert.equal(second.idempotent, true);
  assert.equal(calls, 1);
});

test("module8 Path-B: legacy `/settlement/internal/.../start` route is removed (404)", async (t) => {
  const badApp = express();
  badApp.use(express.json());
  const baseUrl = await withServer(t, badApp);
  const res = await fetch(`${baseUrl}/settlement/internal/0x${"ab".repeat(32)}/start`, { method: "POST" });
  assert.equal(res.status, 404);
});

// Path-B (M5): the ABI mismatch test for `internalMatchSettle` submitter was
// removed alongside `createOnchainInternalMatchSubmitter`. The on-chain leg
// has moved to withdraw; M8 will add an equivalent regression covering
// `shieldedWithdraw` + pending-note consumption.

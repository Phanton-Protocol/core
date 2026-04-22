const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require("crypto");
const { ethers } = require('ethers');
const {
  getInternalOrderById,
  listInternalOrdersForMatching,
  compareAndSetInternalOrderState,
  saveOrderEvent,
  saveMatch,
  getMatchByHash,
  saveFill,
  listFillsByMatch,
} = require("./db");
const { ORDER_STATUS, assertLegalTransition } = require("./internalOrderLifecycle");
const router = express.Router();

const FHE_SERVICE_URL = (process.env.FHE_SERVICE_URL || '').replace(/\/$/, '');

async function fheRemoteFetch(relPath, init) {
  if (!FHE_SERVICE_URL) return null;
  const url = `${FHE_SERVICE_URL}${relPath.startsWith('/') ? '' : '/'}${relPath}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Number(process.env.FHE_SERVICE_TIMEOUT_MS || 30000));
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await r.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    if (!r.ok) {
      const err = new Error(body?.error || body?.message || `FHE service ${r.status}`);
      err.status = r.status;
      err.body = body;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

const ORDER_STORE_FILE = process.env.MATCHING_ORDER_STORE || path.join(__dirname, '..', 'data', 'matching-orders.json');
const orderBook = new Map();
const MAX_ORDERS_PER_PAIR = 50;
const DEFAULT_RESERVATION_TTL_MS = Number(process.env.MATCHING_RESERVATION_TTL_MS || 90_000);
let matchingContext = {
  db: null,
  reservationTtlMs: DEFAULT_RESERVATION_TTL_MS,
};
let jsonFallbackLock = Promise.resolve();

function orderBookKey(inputAssetID, outputAssetID) {
  return `${Number(inputAssetID)}-${Number(outputAssetID)}`;
}

function normalizeFheOrder(order) {
  if (!order || order.inputAssetID === undefined || order.outputAssetID === undefined) return null;
  const inputAssetID = Number(order.inputAssetID);
  const outputAssetID = Number(order.outputAssetID);
  if (!Number.isFinite(inputAssetID) || !Number.isFinite(outputAssetID)) return null;
  return {
    ...order,
    inputAssetID,
    outputAssetID,
    fheEncryptedInputAmount: order.fheEncryptedInputAmount,
    fheEncryptedMinOutput: order.fheEncryptedMinOutput,
  };
}

function normalizeBigIntString(v) {
  return BigInt(v == null ? "0" : String(v)).toString();
}

function computeStableMatchHash(payload) {
  return ethers.keccak256(
    ethers.toUtf8Bytes(
      JSON.stringify({
        pairBase: payload.pairBase,
        pairQuote: payload.pairQuote,
        makerOrderId: payload.makerOrderId,
        takerOrderId: payload.takerOrderId,
        quantity: payload.quantity,
        executionPrice: payload.executionPrice,
      })
    )
  );
}

function parseNum(v, fallback = 0n) {
  try {
    return BigInt(String(v));
  } catch {
    return fallback;
  }
}

function sortByTimeNonceIdAsc(a, b) {
  if (Number(a.createdAt || 0) !== Number(b.createdAt || 0)) return Number(a.createdAt || 0) - Number(b.createdAt || 0);
  const an = parseNum(a.nonce, 0n);
  const bn = parseNum(b.nonce, 0n);
  if (an !== bn) return an < bn ? -1 : 1;
  return String(a.id).localeCompare(String(b.id));
}

function isPriceCompatible(taker, maker) {
  const takerPrice = parseNum(taker.limitPrice, 0n);
  const makerPrice = parseNum(maker.limitPrice, 0n);
  if (String(taker.side) === "buy") return takerPrice >= makerPrice;
  return makerPrice >= takerPrice;
}

function getExecutionPrice(taker, maker) {
  return normalizeBigIntString(maker.limitPrice);
}

function toPairKey(order) {
  return `${String(order.pairBase)}::${String(order.pairQuote)}`;
}

function isOrderLiveForMatch(order, nowSec) {
  if (!order) return false;
  if (order.status !== ORDER_STATUS.OPEN && order.status !== ORDER_STATUS.PARTIALLY_FILLED) return false;
  if (parseNum(order.remainingAmount, 0n) <= 0n) return false;
  if (Number(order.expiryTs || 0) <= Number(nowSec)) return false;
  return true;
}

async function withJsonLock(task) {
  const prev = jsonFallbackLock;
  let release;
  jsonFallbackLock = new Promise((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await task();
  } finally {
    release();
  }
}

function configureMatchingEngine(opts = {}) {
  matchingContext = {
    db: opts.db || null,
    reservationTtlMs: Number(opts.reservationTtlMs || DEFAULT_RESERVATION_TTL_MS),
  };
}

function getDb() {
  return matchingContext.db || null;
}

function computeExecutionKey(orderA, orderB) {
  const [left, right] = [String(orderA.id), String(orderB.id)].sort();
  return ethers.keccak256(ethers.toUtf8Bytes(`${left}:${right}`));
}

function buildCounterpartyComparator(taker) {
  const takerIsBuy = String(taker.side) === "buy";
  return (a, b) => {
    const ap = parseNum(a.limitPrice, 0n);
    const bp = parseNum(b.limitPrice, 0n);
    if (ap !== bp) {
      if (takerIsBuy) return ap < bp ? -1 : 1; // lower asks first
      return ap > bp ? -1 : 1; // higher bids first
    }
    return sortByTimeNonceIdAsc(a, b);
  };
}

function selectBestCounterparty(taker, allOrders, nowSec) {
  const takerPair = toPairKey(taker);
  const oppositeSide = String(taker.side) === "buy" ? "sell" : "buy";
  const candidates = allOrders
    .filter((o) =>
      o.id !== taker.id &&
      toPairKey(o) === takerPair &&
      String(o.side) === oppositeSide &&
      isOrderLiveForMatch(o, nowSec) &&
      isPriceCompatible(taker, o)
    )
    .sort(buildCounterpartyComparator(taker));
  return candidates[0] || null;
}

function derivePostFillState(order, fillQty, executionKey, actor) {
  const remainingBefore = parseNum(order.remainingAmount, 0n);
  const filledBefore = parseNum(order.filledAmount, 0n);
  const nextRemaining = remainingBefore - fillQty;
  const nextFilled = filledBefore + fillQty;
  const toStatus = nextRemaining <= 0n ? ORDER_STATUS.FILLED : ORDER_STATUS.PARTIALLY_FILLED;
  return {
    id: order.id,
    status: toStatus,
    remainingAmount: nextRemaining < 0n ? "0" : nextRemaining.toString(),
    filledAmount: nextFilled.toString(),
    reservedAmount: "0",
    matchRef: executionKey,
    updatedBy: actor,
    updatedAt: Date.now(),
  };
}

function reserveOrder(db, order, quantity, executionKey, actor) {
  assertLegalTransition(order.status, ORDER_STATUS.RESERVED);
  const now = Date.now();
  const reservedRow = {
    id: order.id,
    status: ORDER_STATUS.RESERVED,
    remainingAmount: normalizeBigIntString(order.remainingAmount),
    filledAmount: normalizeBigIntString(order.filledAmount),
    reservedAmount: normalizeBigIntString(quantity),
    matchRef: executionKey,
    updatedBy: actor,
    updatedAt: now,
    fromStatuses: [order.status],
  };
  const ok = compareAndSetInternalOrderState(db, reservedRow);
  if (!ok) return false;
  saveOrderEvent(db, {
    id: crypto.randomUUID(),
    orderId: order.id,
    eventType: "order_reserved",
    fromStatus: order.status,
    toStatus: ORDER_STATUS.RESERVED,
    reason: "deterministic_match_reservation",
    actor,
    metadataJson: { executionKey, reservedAmount: String(quantity) },
    createdAt: now,
  });
  return true;
}

function releaseReservation(db, reservedOrder, restoreStatus, executionKey, actor, reason) {
  const now = Date.now();
  const ok = compareAndSetInternalOrderState(db, {
    id: reservedOrder.id,
    status: restoreStatus,
    remainingAmount: normalizeBigIntString(reservedOrder.remainingAmount),
    filledAmount: normalizeBigIntString(reservedOrder.filledAmount),
    reservedAmount: "0",
    matchRef: null,
    updatedBy: actor,
    updatedAt: now,
    fromStatuses: [ORDER_STATUS.RESERVED],
  });
  if (!ok) return false;
  saveOrderEvent(db, {
    id: crypto.randomUUID(),
    orderId: reservedOrder.id,
    eventType: "order_unreserved",
    fromStatus: ORDER_STATUS.RESERVED,
    toStatus: restoreStatus,
    reason: reason || "reservation_released",
    actor,
    metadataJson: { executionKey },
    createdAt: now,
  });
  return true;
}

function persistMatchAndFills(db, payload) {
  const existing = getMatchByHash(db, payload.matchHash);
  if (existing) {
    return {
      idempotent: true,
      match: existing,
      fills: listFillsByMatch(db, existing.id),
    };
  }

  const now = Date.now();
  const matchId = crypto.randomUUID();
  saveMatch(db, {
    id: matchId,
    matchHash: payload.matchHash,
    executionKey: payload.executionKey,
    pairBase: payload.pairBase,
    pairQuote: payload.pairQuote,
    makerOrderId: payload.maker.id,
    takerOrderId: payload.taker.id,
    makerSide: payload.maker.side,
    takerSide: payload.taker.side,
    executionPrice: payload.executionPrice,
    quantity: payload.quantity.toString(),
    status: "finalized",
    metadataJson: {
      reason: "price_time_priority_match",
      makerRemainingBefore: payload.maker.remainingAmount,
      takerRemainingBefore: payload.taker.remainingAmount,
    },
    createdAt: now,
  });
  saveFill(db, {
    id: crypto.randomUUID(),
    matchId,
    orderId: payload.maker.id,
    side: payload.maker.side,
    quantity: payload.quantity.toString(),
    price: payload.executionPrice,
    isMaker: true,
    createdAt: now,
  });
  saveFill(db, {
    id: crypto.randomUUID(),
    matchId,
    orderId: payload.taker.id,
    side: payload.taker.side,
    quantity: payload.quantity.toString(),
    price: payload.executionPrice,
    isMaker: false,
    createdAt: now,
  });
  return {
    idempotent: false,
    match: getMatchByHash(db, payload.matchHash),
    fills: listFillsByMatch(db, matchId),
  };
}

function runDeterministicMatchForOrderCore(db, takerOrderId, workerId = "matcher") {
  const nowSec = Math.floor(Date.now() / 1000);
  const taker = getInternalOrderById(db, takerOrderId);
  if (!taker || !isOrderLiveForMatch(taker, nowSec)) {
    return { matched: false, reason: "taker_not_matchable" };
  }

  const universe = listInternalOrdersForMatching(db);
  const maker = selectBestCounterparty(taker, universe, nowSec);
  if (!maker) {
    return { matched: false, reason: "no_compatible_counterparty" };
  }

  const fillQty = parseNum(taker.remainingAmount, 0n) < parseNum(maker.remainingAmount, 0n)
    ? parseNum(taker.remainingAmount, 0n)
    : parseNum(maker.remainingAmount, 0n);
  if (fillQty <= 0n) return { matched: false, reason: "non_positive_fill_qty" };

  const executionKey = computeExecutionKey(taker, maker);
  const actor = `matcher:${workerId}`;
  const takerBeforeStatus = taker.status;
  const makerBeforeStatus = maker.status;

  const takerReserved = reserveOrder(db, taker, fillQty, executionKey, actor);
  if (!takerReserved) return { matched: false, reason: "taker_reservation_conflict" };

  const makerFresh = getInternalOrderById(db, maker.id);
  if (!makerFresh || !isOrderLiveForMatch(makerFresh, nowSec)) {
    releaseReservation(db, getInternalOrderById(db, taker.id), takerBeforeStatus, executionKey, actor, "maker_unavailable");
    return { matched: false, reason: "maker_unavailable_after_taker_reserve" };
  }

  const makerReserved = reserveOrder(db, makerFresh, fillQty, executionKey, actor);
  if (!makerReserved) {
    releaseReservation(db, getInternalOrderById(db, taker.id), takerBeforeStatus, executionKey, actor, "maker_reservation_conflict");
    return { matched: false, reason: "maker_reservation_conflict" };
  }

  const takerReservedRow = getInternalOrderById(db, taker.id);
  const makerReservedRow = getInternalOrderById(db, maker.id);
  const executionPrice = getExecutionPrice(takerReservedRow, makerReservedRow);
  const matchHash = computeStableMatchHash({
    pairBase: taker.pairBase,
    pairQuote: taker.pairQuote,
    makerOrderId: maker.id,
    takerOrderId: taker.id,
    quantity: fillQty.toString(),
    executionPrice,
  });

  const tx = () => {
    const persisted = persistMatchAndFills(db, {
      matchHash,
      executionKey,
      pairBase: taker.pairBase,
      pairQuote: taker.pairQuote,
      maker: makerReservedRow,
      taker: takerReservedRow,
      executionPrice,
      quantity: fillQty,
    });

    const takerAfter = derivePostFillState(takerReservedRow, fillQty, executionKey, actor);
    const makerAfter = derivePostFillState(makerReservedRow, fillQty, executionKey, actor);
    assertLegalTransition(ORDER_STATUS.RESERVED, takerAfter.status);
    assertLegalTransition(ORDER_STATUS.RESERVED, makerAfter.status);

    const takerOk = compareAndSetInternalOrderState(db, {
      ...takerAfter,
      fromStatuses: [ORDER_STATUS.RESERVED],
    });
    const makerOk = compareAndSetInternalOrderState(db, {
      ...makerAfter,
      fromStatuses: [ORDER_STATUS.RESERVED],
    });
    if (!takerOk || !makerOk) throw new Error("finalize_reservation_cas_failed");

    const now = Date.now();
    saveOrderEvent(db, {
      id: crypto.randomUUID(),
      orderId: taker.id,
      eventType: "order_matched_fill",
      fromStatus: ORDER_STATUS.RESERVED,
      toStatus: takerAfter.status,
      reason: "deterministic_match_finalize",
      actor,
      metadataJson: { executionKey, matchHash, quantity: fillQty.toString(), price: executionPrice, role: "taker" },
      createdAt: now,
    });
    saveOrderEvent(db, {
      id: crypto.randomUUID(),
      orderId: maker.id,
      eventType: "order_matched_fill",
      fromStatus: ORDER_STATUS.RESERVED,
      toStatus: makerAfter.status,
      reason: "deterministic_match_finalize",
      actor,
      metadataJson: { executionKey, matchHash, quantity: fillQty.toString(), price: executionPrice, role: "maker" },
      createdAt: now,
    });

    return {
      matched: true,
      idempotent: persisted.idempotent,
      reason: "matched",
      executionKey,
      matchHash,
      quantity: fillQty.toString(),
      executionPrice,
      makerOrderId: maker.id,
      takerOrderId: taker.id,
      fills: persisted.fills,
    };
  };

  try {
    if (typeof db.transaction === "function") {
      return db.transaction(tx)();
    }
    return tx();
  } catch (e) {
    const tRow = getInternalOrderById(db, taker.id);
    const mRow = getInternalOrderById(db, maker.id);
    if (tRow?.status === ORDER_STATUS.RESERVED) {
      releaseReservation(db, tRow, takerBeforeStatus, executionKey, actor, "finalization_failed");
    }
    if (mRow?.status === ORDER_STATUS.RESERVED) {
      releaseReservation(db, mRow, makerBeforeStatus, executionKey, actor, "finalization_failed");
    }
    return { matched: false, reason: "finalization_failed", error: e.message || String(e) };
  }
}

async function runDeterministicMatchForOrder(orderId, workerId = "matcher") {
  const db = getDb();
  if (!db) return { matched: false, reason: "db_not_configured" };
  if (typeof db.transaction === "function") {
    return runDeterministicMatchForOrderCore(db, orderId, workerId);
  }
  return withJsonLock(async () => runDeterministicMatchForOrderCore(db, orderId, workerId));
}

async function reconcileStaleReservations(workerId = "matcher") {
  const db = getDb();
  if (!db) return { scanned: 0, released: 0 };
  const now = Date.now();
  const cutoff = now - Number(matchingContext.reservationTtlMs || DEFAULT_RESERVATION_TTL_MS);
  const run = () => {
    const orders = listInternalOrdersForMatching(db);
    let released = 0;
    for (const order of orders) {
      if (order.status !== ORDER_STATUS.RESERVED) continue;
      if (Number(order.updatedAt || 0) > cutoff) continue;
      const restore = parseNum(order.filledAmount, 0n) > 0n ? ORDER_STATUS.PARTIALLY_FILLED : ORDER_STATUS.OPEN;
      if (!assertLegalTransition) continue;
      try {
        assertLegalTransition(ORDER_STATUS.RESERVED, restore);
      } catch {
        continue;
      }
      const ok = releaseReservation(db, order, restore, order.matchRef || null, `matcher:${workerId}`, "reservation_ttl_recovery");
      if (ok) released += 1;
    }
    return { scanned: orders.length, released };
  };
  if (typeof db.transaction === "function") return db.transaction(run)();
  return withJsonLock(async () => run());
}

function loadOrderBook() {
  try {
    if (!fs.existsSync(ORDER_STORE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(ORDER_STORE_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    for (const [k, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      orderBook.set(k, list.slice(-MAX_ORDERS_PER_PAIR));
    }
  } catch (_) {}
}

function persistOrderBook() {
  try {
    const out = {};
    for (const [k, list] of orderBook.entries()) out[k] = list;
    const dir = path.dirname(ORDER_STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ORDER_STORE_FILE, JSON.stringify(out), 'utf8');
  } catch (_) {}
}

async function registerOrderAndTryMatch(order) {
  const db = getDb();
  if (db && order?.orderId && typeof order.orderId === "string") {
    await reconcileStaleReservations("register");
    return runDeterministicMatchForOrder(order.orderId, order.workerId || "register");
  }
  const normalized = normalizeFheOrder(order);
  if (!normalized) {
    return { matched: false, error: "invalid_order_asset_ids" };
  }
  const key = orderBookKey(normalized.inputAssetID, normalized.outputAssetID);
  const reverseKey = orderBookKey(normalized.outputAssetID, normalized.inputAssetID);
  const reverseList = orderBook.get(reverseKey);
  if (reverseList && reverseList.length > 0) {
    const existing = reverseList[reverseList.length - 1];
    const result = await matchOrdersFHE(normalized, existing);
    if (result.matched) {
      reverseList.pop();
      if (reverseList.length === 0) orderBook.delete(reverseKey);
      else orderBook.set(reverseKey, reverseList);
      persistOrderBook();
      return { matched: true, matchResult: result };
    }
  }
  const list = orderBook.get(key) || [];
  list.push({ ...normalized, ts: Date.now() });
  if (list.length > MAX_ORDERS_PER_PAIR) list.shift();
  orderBook.set(key, list);
  persistOrderBook();
  return { matched: false };
}

async function matchOrdersFHE(order1, order2) {
  console.log('🔄 Matching FHE-encrypted orders...');

  if (FHE_SERVICE_URL) {
    try {
      const remote = await fheRemoteFetch('/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order1, order2 }),
      });
      if (remote && typeof remote.matched === 'boolean') return remote;
    } catch (e) {
      console.error('FHE remote /match failed:', e.message || e);
      throw e;
    }
  }

  const a1 = Number(order1.inputAssetID);
  const a2 = Number(order1.outputAssetID);
  const b1 = Number(order2.inputAssetID);
  const b2 = Number(order2.outputAssetID);
  const assetsMatch = a1 === b2 && a2 === b1;
  
  if (!assetsMatch) {
    return {
      matched: false,
      fheEncryptedResult: '0x',
      executionId: ethers.ZeroHash
    };
  }

  const executionId = ethers.keccak256(
    ethers.concat([
      ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(order1.fheEncryptedInputAmount))),
      ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(order2.fheEncryptedInputAmount))),
      ethers.toUtf8Bytes(Date.now().toString())
    ])
  );

  const fheEncryptedResult = ethers.hexlify(
    ethers.toUtf8Bytes(`FHE_MATCH:${executionId}`)
  );
  
  console.log('✅ Orders matched via FHE');
  
  return {
    matched: true,
    fheEncryptedResult,
    executionId
  };
}

router.post('/match', async (req, res) => {
  try {
    const { order1, order2 } = req.body;
    
    if (!order1 || !order2) {
      return res.status(400).json({ error: 'Missing order data' });
    }

    const n1 = normalizeFheOrder(order1);
    const n2 = normalizeFheOrder(order2);
    if (!n1 || !n2) {
      return res.status(400).json({ error: 'Invalid order asset IDs' });
    }

    if (FHE_SERVICE_URL) {
      try {
        const remote = await fheRemoteFetch('/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order1: n1, order2: n2 }),
        });
        return res.json(remote);
      } catch (e) {
        const code = e.status >= 400 && e.status < 600 ? e.status : 502;
        return res.status(code).json({ error: e.message || 'FHE service error' });
      }
    }

    const result = await matchOrdersFHE(n1, n2);
    res.json(result);
  } catch (error) {
    console.error('❌ FHE matching error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/register', async (req, res) => {
  try {
    const order = req.body;
    if (!order || order.inputAssetID === undefined || order.outputAssetID === undefined) {
      return res.status(400).json({ error: 'Missing order or asset IDs' });
    }
    const { matched, matchResult, error } = await registerOrderAndTryMatch(order);
    if (error) return res.status(400).json({ error });
    res.json({ matched, matchResult: matchResult || null });
  } catch (error) {
    console.error('❌ FHE register error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/internal/match", async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || "");
    const workerId = String(req.body?.workerId || "api");
    if (!ethers.isHexString(orderId, 32)) {
      return res.status(400).json({ error: "invalid_order_id" });
    }
    await reconcileStaleReservations(workerId);
    const out = await runDeterministicMatchForOrder(orderId, workerId);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message || "internal_match_failed" });
  }
});

router.post("/internal/reconcile", async (req, res) => {
  try {
    const workerId = String(req.body?.workerId || "api");
    const out = await reconcileStaleReservations(workerId);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message || "reconcile_failed" });
  }
});

router.get('/health', (req, res) => {
  const openOrders = Array.from(orderBook.values()).reduce((sum, arr) => sum + arr.length, 0);
  res.json({
    status: 'healthy',
    service: 'FHE Matching Service',
    fheEnabled: true,
    orderPairs: orderBook.size,
    openOrders,
    fheMode: FHE_SERVICE_URL ? 'remote' : 'mock',
    fheLibrary: FHE_SERVICE_URL ? 'remote-service' : 'deterministic-mock',
    fheServiceConfigured: Boolean(FHE_SERVICE_URL),
  });
});

router.post('/compute', async (req, res) => {
  try {
    const { operation, encryptedInputs } = req.body;
    
    if (!operation || !encryptedInputs) {
      return res.status(400).json({ error: 'Missing operation or inputs' });
    }

    if (FHE_SERVICE_URL) {
      try {
        const remote = await fheRemoteFetch('/compute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
        });
        return res.json(remote);
      } catch (e) {
        const code = e.status >= 400 && e.status < 600 ? e.status : 502;
        return res.status(code).json({ error: e.message || 'FHE service error' });
      }
    }

    console.log(`🔄 FHE computation: ${operation}`);

    const result = {
      operation,
      fheEncryptedResult: ethers.hexlify(ethers.randomBytes(32)),
      executionId: ethers.keccak256(ethers.toUtf8Bytes(Date.now().toString()))
    };
    
    res.json(result);
  } catch (error) {
    console.error('❌ FHE computation error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/public-key', async (req, res) => {
  if (FHE_SERVICE_URL) {
    try {
      const remote = await fheRemoteFetch('/public-key', { method: 'GET' });
      return res.json(remote);
    } catch (e) {
      const code = e.status >= 400 && e.status < 600 ? e.status : 502;
      return res.status(code).json({ error: e.message || 'FHE service error' });
    }
  }
  res.json({ publicKey: ethers.hexlify(ethers.randomBytes(32)) });
});

router.post('/encrypt', async (req, res) => {
  try {
    if (FHE_SERVICE_URL) {
      try {
        const remote = await fheRemoteFetch('/encrypt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
        });
        return res.json(remote);
      } catch (e) {
        const code = e.status >= 400 && e.status < 600 ? e.status : 502;
        return res.status(code).json({ error: e.message || 'FHE service error' });
      }
    }
    res.json({ ciphertext: req.body });
  } catch (e) {
    res.status(500).json({ error: e.message || 'encrypt failed' });
  }
});

router.post('/order', async (req, res) => {
  try {
    const encrypted = req.body?.ciphertext ?? req.body?.encrypted ?? req.body;
    if (!encrypted) {
      return res.status(400).json({ error: 'Missing order payload' });
    }

    const side = encrypted.side || 'sell';
    let assetIn = encrypted.assetIn;
    let assetOut = encrypted.assetOut;
    if (assetIn === undefined || assetOut === undefined) {
      return res.status(400).json({ error: 'Missing assetIn/assetOut' });
    }

    const inputAssetID = Number(assetIn);
    const outputAssetID = Number(assetOut);
    if (!Number.isFinite(inputAssetID) || !Number.isFinite(outputAssetID)) {
      return res.status(400).json({ error: 'Invalid asset IDs' });
    }

    const toFheBytes = (v) => ethers.hexlify(ethers.toUtf8Bytes(String(v)));
    const order = {
      inputAssetID,
      outputAssetID,
      fheEncryptedInputAmount: toFheBytes(encrypted.amount ?? '0'),
      fheEncryptedMinOutput: toFheBytes(encrypted.price ?? '0'),
    };

    const result = await registerOrderAndTryMatch(order);

    const orderId = ethers.keccak256(
      ethers.toUtf8Bytes(
        JSON.stringify({ inputAssetID, outputAssetID, side, ts: Date.now(), matched: !!result.matched })
      )
    );

    res.json({
      orderId,
      matched: !!result.matched,
      matchResult: result.matchResult ?? null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'order failed' });
  }
});

function getFheMatchMode() {
  return FHE_SERVICE_URL ? 'remote' : 'mock';
}

module.exports = router;
module.exports.registerOrderAndTryMatch = registerOrderAndTryMatch;
module.exports.getFheMatchMode = getFheMatchMode;
module.exports.normalizeFheOrder = normalizeFheOrder;
module.exports.configureMatchingEngine = configureMatchingEngine;
module.exports.runDeterministicMatchForOrder = runDeterministicMatchForOrder;
module.exports.reconcileStaleReservations = reconcileStaleReservations;
loadOrderBook();
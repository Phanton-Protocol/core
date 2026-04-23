const fs = require("fs");
const path = require("path");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function initDbJson(dbPath) {
  const dir = path.dirname(dbPath);
  ensureDir(dir);
  const base = path.basename(dbPath, path.extname(dbPath));
  const dataDir = path.join(dir, base + "_data");
  ensureDir(dataDir);

  const tables = [
    "intents",
    "receipts",
    "quotes",
    "commitments",
    "notes",
    "deposit_sessions",
    "deposit_tx_receipts",
    "orders",
    "order_events",
    "cancellations",
    "matches",
    "fills",
    "match_decisions",
    "settlement_executions",
    "settlement_events",
    "compliance_decisions",
    "attestation_decisions"
  ];
  const keyCol = {
    intents: "intentId",
    receipts: "intentId",
    quotes: "id",
    commitments: "commitment",
    notes: "noteId",
    deposit_sessions: "sessionId",
    deposit_tx_receipts: "id",
    orders: "id",
    order_events: "id",
    cancellations: "id",
    matches: "id",
    fills: "id",
    match_decisions: "id",
    settlement_executions: "executionId",
    settlement_events: "id",
    compliance_decisions: "id",
    attestation_decisions: "id",
  };

  function loadTable(name) {
    const f = path.join(dataDir, name + ".json");
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      return [];
    }
  }
  function saveTable(name, rows) {
    const f = path.join(dataDir, name + ".json");
    fs.writeFileSync(f, JSON.stringify(rows, null, 0), "utf8");
  }

  function prepare(sql) {
    const sqlLower = sql.toLowerCase();
    const run = (...args) => {
      if (sqlLower.includes("insert or replace into intents")) {
        const [intentId, userAddress, payload, createdAt] = args;
        const rows = loadTable("intents").filter((r) => r.intentId !== intentId);
        rows.push({ intentId, userAddress, payload, createdAt });
        saveTable("intents", rows);
      } else if (sqlLower.includes("insert or replace into receipts")) {
        const [intentId, userAddress, payload, createdAt] = args;
        const rows = loadTable("receipts").filter((r) => r.intentId !== intentId);
        rows.push({ intentId, userAddress, payload, createdAt });
        saveTable("receipts", rows);
      } else if (sqlLower.includes("insert or replace into quotes")) {
        const [id, userAddress, payload, createdAt] = args;
        const rows = loadTable("quotes").filter((r) => r.id !== id);
        rows.push({ id, userAddress, payload, createdAt });
        saveTable("quotes", rows);
      } else if (sqlLower.includes("insert or replace into commitments")) {
        const [commitment, idx, txHash, createdAt] = args;
        const rows = loadTable("commitments").filter((r) => r.commitment !== commitment);
        rows.push({ commitment, idx, txHash, createdAt });
        saveTable("commitments", rows);
      } else if (sqlLower.includes("insert or replace into notes")) {
        const [noteId, ownerAddress, commitment, txHash, payloadEnc, createdAt, updatedAt] = args;
        const rows = loadTable("notes").filter((r) => r.noteId !== noteId);
        rows.push({ noteId, ownerAddress, commitment, txHash, payloadEnc, createdAt, updatedAt });
        saveTable("notes", rows);
      } else if (sqlLower.includes("delete from commitments")) {
        saveTable("commitments", []);
      } else if (sqlLower.includes("insert or replace into deposit_sessions")) {
        const [
          sessionId,
          sessionToken,
          idempotencyKey,
          depositor,
          mode,
          token,
          amount,
          assetId,
          status,
          payload,
          createdAt,
          updatedAt,
        ] = args;
        const rows = loadTable("deposit_sessions").filter((r) => r.sessionId !== sessionId);
        rows.push({
          sessionId,
          sessionToken,
          idempotencyKey,
          depositor,
          mode,
          token,
          amount,
          assetId,
          status,
          payload,
          createdAt,
          updatedAt,
        });
        saveTable("deposit_sessions", rows);
      } else if (sqlLower.includes("insert into deposit_tx_receipts")) {
        const [id, sessionId, txHash, receiptJson, createdAt] = args;
        const rows = loadTable("deposit_tx_receipts");
        rows.push({ id, sessionId, txHash, receiptJson, createdAt });
        saveTable("deposit_tx_receipts", rows);
      } else if (sqlLower.includes("insert into orders")) {
        const [
          id,
          ownerAddress,
          signingKey,
          pairBase,
          pairQuote,
          side,
          status,
          amount,
          limitPrice,
          remainingAmount,
          filledAmount,
          reservedAmount,
          nonce,
          replayKey,
          signatureHash,
          expiryTs,
          encryptedPayload,
          normalizedPayload,
          matchRef,
          createdBy,
          updatedBy,
          createdAt,
          updatedAt
        ] = args;
        const rows = loadTable("orders").filter((r) => r.id !== id);
        rows.push({
          id,
          ownerAddress,
          signingKey,
          pairBase,
          pairQuote,
          side,
          status,
          amount,
          limitPrice,
          remainingAmount,
          filledAmount,
          reservedAmount,
          nonce,
          replayKey,
          signatureHash,
          expiryTs,
          encryptedPayload,
          normalizedPayload,
          matchRef,
          createdBy,
          updatedBy,
          createdAt,
          updatedAt,
        });
        saveTable("orders", rows);
      } else if (sqlLower.includes("update orders") && sqlLower.includes("set status")) {
        const [status, remainingAmount, filledAmount, reservedAmount, matchRef, updatedBy, updatedAt, id] = args;
        const rows = loadTable("orders");
        const idx = rows.findIndex((r) => r.id === id);
        if (idx >= 0) {
          rows[idx] = {
            ...rows[idx],
            status,
            remainingAmount,
            filledAmount,
            reservedAmount,
            matchRef,
            updatedBy,
            updatedAt,
          };
          saveTable("orders", rows);
        }
      } else if (sqlLower.includes("insert into order_events")) {
        const [id, orderId, eventType, fromStatus, toStatus, reason, actor, metadataJson, createdAt] = args;
        const rows = loadTable("order_events");
        rows.push({ id, orderId, eventType, fromStatus, toStatus, reason, actor, metadataJson, createdAt });
        saveTable("order_events", rows);
      } else if (sqlLower.includes("insert into cancellations")) {
        const [id, orderId, reason, actor, signatureHash, payloadJson, createdAt] = args;
        const rows = loadTable("cancellations").filter((r) => r.orderId !== orderId);
        rows.push({ id, orderId, reason, actor, signatureHash, payloadJson, createdAt });
        saveTable("cancellations", rows);
      } else if (sqlLower.includes("insert into matches")) {
        const [
          id,
          matchHash,
          executionKey,
          pairBase,
          pairQuote,
          makerOrderId,
          takerOrderId,
          makerSide,
          takerSide,
          executionPrice,
          quantity,
          status,
          decisionReasonCode,
          fheResultHash,
          fheDecisionHash,
          fheAttestationRef,
          metadataJson,
          createdAt
        ] = args;
        const rows = loadTable("matches").filter((r) => r.id !== id && r.matchHash !== matchHash);
        rows.push({
          id,
          matchHash,
          executionKey,
          pairBase,
          pairQuote,
          makerOrderId,
          takerOrderId,
          makerSide,
          takerSide,
          executionPrice,
          quantity,
          status,
          decisionReasonCode,
          fheResultHash,
          fheDecisionHash,
          fheAttestationRef,
          metadataJson,
          createdAt,
        });
        saveTable("matches", rows);
      } else if (sqlLower.includes("insert into fills")) {
        const [id, matchId, orderId, side, quantity, price, isMaker, createdAt] = args;
        const rows = loadTable("fills").filter((r) => r.id !== id);
        rows.push({ id, matchId, orderId, side, quantity, price, isMaker, createdAt });
        saveTable("fills", rows);
      } else if (sqlLower.includes("insert into match_decisions")) {
        const [
          id,
          traceId,
          takerOrderId,
          candidateOrderId,
          matchHash,
          executionKey,
          reasonCode,
          policyMode,
          fheDecisionHash,
          fheResultHash,
          fheAttestationRef,
          detailsJson,
          createdAt
        ] = args;
        const rows = loadTable("match_decisions").filter((r) => r.id !== id);
        rows.push({
          id,
          traceId,
          takerOrderId,
          candidateOrderId,
          matchHash,
          executionKey,
          reasonCode,
          policyMode,
          fheDecisionHash,
          fheResultHash,
          fheAttestationRef,
          detailsJson,
          createdAt,
        });
        saveTable("match_decisions", rows);
      } else if (sqlLower.includes("insert or ignore into settlement_executions")) {
        const [
          executionId,
          matchHash,
          executionKey,
          status,
          attemptCount,
          txHash,
          traceId,
          fallbackMode,
          fallbackReasonCode,
          errorCode,
          errorMessage,
          payloadJson,
          createdAt,
          updatedAt,
          lastAttemptAt
        ] = args;
        const rows = loadTable("settlement_executions");
        const existing = rows.find((r) => r.matchHash === matchHash);
        if (!existing) {
          rows.push({
            executionId,
            matchHash,
            executionKey,
            status,
            attemptCount,
            txHash,
            traceId,
            fallbackMode,
            fallbackReasonCode,
            errorCode,
            errorMessage,
            payloadJson,
            createdAt,
            updatedAt,
            lastAttemptAt,
          });
          saveTable("settlement_executions", rows);
        }
      } else if (sqlLower.includes("update settlement_executions") && sqlLower.includes("set status")) {
        const [
          status,
          attemptCount,
          txHash,
          traceId,
          fallbackMode,
          fallbackReasonCode,
          errorCode,
          errorMessage,
          payloadJson,
          updatedAt,
          lastAttemptAt,
          executionId
        ] = args;
        const rows = loadTable("settlement_executions");
        const idx = rows.findIndex((r) => r.executionId === executionId);
        if (idx >= 0) {
          rows[idx] = {
            ...rows[idx],
            status,
            attemptCount,
            txHash,
            traceId,
            fallbackMode,
            fallbackReasonCode,
            errorCode,
            errorMessage,
            payloadJson,
            updatedAt,
            lastAttemptAt,
          };
          saveTable("settlement_executions", rows);
        }
      } else if (sqlLower.includes("insert into settlement_events")) {
        const [id, executionId, matchHash, traceId, eventType, reasonCode, detailsJson, createdAt] = args;
        const rows = loadTable("settlement_events");
        rows.push({ id, executionId, matchHash, traceId, eventType, reasonCode, detailsJson, createdAt });
        saveTable("settlement_events", rows);
      } else if (sqlLower.includes("insert into compliance_decisions")) {
        const [
          id, phase, action, orderId, actorRef, counterpartyRef, matchHash, executionKey, executionId,
          traceId, reasonCode, policyMode, policyVersion, evidenceRef, providerResponseHash, detailsJson, createdAt
        ] = args;
        const rows = loadTable("compliance_decisions").filter((r) => r.id !== id);
        rows.push({
          id, phase, action, orderId, actorRef, counterpartyRef, matchHash, executionKey, executionId,
          traceId, reasonCode, policyMode, policyVersion, evidenceRef, providerResponseHash, detailsJson, createdAt
        });
        saveTable("compliance_decisions", rows);
      } else if (sqlLower.includes("insert into attestation_decisions")) {
        const [
          id, matchHash, executionKey, executionId, traceId, policyVersion, requiredQuorumBps, valid,
          reasonCode, signerCount, signerSetHash, detailsJson, createdAt
        ] = args;
        const rows = loadTable("attestation_decisions").filter((r) => r.id !== id);
        rows.push({
          id, matchHash, executionKey, executionId, traceId, policyVersion, requiredQuorumBps, valid,
          reasonCode, signerCount, signerSetHash, detailsJson, createdAt
        });
        saveTable("attestation_decisions", rows);
      }
    };
    const get = (...args) => {
      if (sqlLower.includes("from intents where")) {
        const [intentId] = args;
        const row = loadTable("intents").find((r) => r.intentId === intentId);
        return row ? { intentId: row.intentId, userAddress: row.userAddress, payload: row.payload } : undefined;
      }
      if (sqlLower.includes("from receipts where")) {
        const [intentId] = args;
        const row = loadTable("receipts").find((r) => r.intentId === intentId);
        return row ? { payload: row.payload } : undefined;
      }
      if (sqlLower.includes("from commitments where")) {
        const [commitment] = args;
        const row = loadTable("commitments").find((r) => String(r.commitment).toLowerCase() === String(commitment).toLowerCase());
        return row ? { commitment: row.commitment, idx: row.idx } : undefined;
      }
      if (sqlLower.includes("from notes where noteid")) {
        const [noteId] = args;
        const row = loadTable("notes").find((r) => String(r.noteId) === String(noteId));
        return row ? { ...row } : undefined;
      }
      if (sqlLower.includes("from notes where commitment")) {
        const [commitment] = args;
        const row = loadTable("notes").find(
          (r) => String(r.commitment).toLowerCase() === String(commitment).toLowerCase()
        );
        return row ? { ...row } : undefined;
      }
      if (sqlLower.includes("from deposit_sessions where idempotencykey")) {
        const [idempotencyKey] = args;
        return loadTable("deposit_sessions").find((r) => r.idempotencyKey === idempotencyKey);
      }
      if (sqlLower.includes("from deposit_sessions where sessionid")) {
        const [sessionId] = args;
        return loadTable("deposit_sessions").find((r) => r.sessionId === sessionId);
      }
      if (sqlLower.includes("from orders where id")) {
        const [id] = args;
        const row = loadTable("orders").find((r) => r.id === id);
        return row ? { ...row } : undefined;
      }
      if (sqlLower.includes("from orders where replaykey")) {
        const [replayKey] = args;
        const row = loadTable("orders").find((r) => r.replayKey === replayKey);
        return row ? { ...row } : undefined;
      }
      if (sqlLower.includes("from orders where owneraddress") && sqlLower.includes("nonce")) {
        const [ownerAddress, nonce] = args;
        const row = loadTable("orders").find((r) => r.ownerAddress === ownerAddress && r.nonce === nonce);
        return row ? { ...row } : undefined;
      }
      if (sqlLower.includes("from matches where matchhash")) {
        const [matchHash] = args;
        const row = loadTable("matches").find((r) => r.matchHash === matchHash);
        return row ? { ...row } : undefined;
      }
      if (sqlLower.includes("from settlement_executions where matchhash")) {
        const [matchHash] = args;
        const row = loadTable("settlement_executions").find((r) => r.matchHash === matchHash);
        return row ? { ...row } : undefined;
      }
      if (sqlLower.includes("from settlement_executions where executionid")) {
        const [executionId] = args;
        const row = loadTable("settlement_executions").find((r) => r.executionId === executionId);
        return row ? { ...row } : undefined;
      }
      return undefined;
    };
    const all = (...args) => {
      if (sqlLower.includes("from receipts where") && sqlLower.includes("order by")) {
        const [userAddress, limit] = args;
        return loadTable("receipts")
          .filter((r) => r.userAddress === userAddress)
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
          .slice(0, limit || 50)
          .map((r) => ({ payload: r.payload }));
      }
      if (sqlLower.includes("from commitments order by")) {
        return loadTable("commitments").sort((a, b) => (a.idx || 0) - (b.idx || 0));
      }
      if (sqlLower.includes("from intents order by")) {
        return loadTable("intents").sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((r) => ({ payload: r.payload }));
      }
      if (sqlLower.includes("from receipts order by")) {
        return loadTable("receipts").sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((r) => ({ payload: r.payload }));
      }
      if (sqlLower.includes("from quotes order by")) {
        return loadTable("quotes").sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((r) => ({ payload: r.payload }));
      }
      if (sqlLower.includes("commitment, idx, txhash, createdat from commitments")) {
        return loadTable("commitments").sort((a, b) => (a.idx || 0) - (b.idx || 0));
      }
      if (sqlLower.includes("from notes where owneraddress")) {
        const [ownerAddress, limit] = args;
        return loadTable("notes")
          .filter((r) => String(r.ownerAddress).toLowerCase() === String(ownerAddress).toLowerCase())
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
          .slice(0, limit || 50);
      }
      if (sqlLower.includes("from orders where status =")) {
        const [status, limit, offset] = args;
        return loadTable("orders")
          .filter((r) => r.status === status)
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || String(b.id).localeCompare(String(a.id)))
          .slice(offset || 0, (offset || 0) + (limit || 50));
      }
      if (sqlLower.includes("from orders order by")) {
        const [limit, offset] = args;
        return loadTable("orders")
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || String(b.id).localeCompare(String(a.id)))
          .slice(offset || 0, (offset || 0) + (limit || 50));
      }
      if (sqlLower.includes("from order_events where orderid")) {
        const [orderId] = args;
        return loadTable("order_events")
          .filter((r) => r.orderId === orderId)
          .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id)));
      }
      if (sqlLower.includes("from fills where matchid")) {
        const [matchId] = args;
        return loadTable("fills")
          .filter((r) => r.matchId === matchId)
          .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id)));
      }
      if (sqlLower.includes("from match_decisions where takerorderid") || sqlLower.includes("from match_decisions where candidateorderid")) {
        const [orderId, limit] = args;
        return loadTable("match_decisions")
          .filter((r) => r.takerOrderId === orderId || r.candidateOrderId === orderId)
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || String(b.id).localeCompare(String(a.id)))
          .slice(0, limit || 100);
      }
      if (sqlLower.includes("from settlement_events where executionid")) {
        const [executionId, limit] = args;
        return loadTable("settlement_events")
          .filter((r) => r.executionId === executionId)
          .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id)))
          .slice(0, limit || 200);
      }
      if (sqlLower.includes("from compliance_decisions where orderid =")) {
        const [orderId, limit] = args;
        return loadTable("compliance_decisions")
          .filter((r) => r.orderId === orderId)
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || String(b.id).localeCompare(String(a.id)))
          .slice(0, limit || 200);
      }
      if (sqlLower.includes("from compliance_decisions where matchhash =")) {
        const [matchHash, limit] = args;
        return loadTable("compliance_decisions")
          .filter((r) => r.matchHash === matchHash)
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || String(b.id).localeCompare(String(a.id)))
          .slice(0, limit || 200);
      }
      if (sqlLower.includes("from compliance_decisions where executionid =")) {
        const [executionId, limit] = args;
        return loadTable("compliance_decisions")
          .filter((r) => r.executionId === executionId)
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || String(b.id).localeCompare(String(a.id)))
          .slice(0, limit || 200);
      }
      if (sqlLower.includes("from attestation_decisions where matchhash =")) {
        const [matchHash, limit] = args;
        return loadTable("attestation_decisions")
          .filter((r) => r.matchHash === matchHash)
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || String(b.id).localeCompare(String(a.id)))
          .slice(0, limit || 100);
      }
      if (sqlLower.includes("from attestation_decisions where executionid =")) {
        const [executionId, limit] = args;
        return loadTable("attestation_decisions")
          .filter((r) => r.executionId === executionId)
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || String(b.id).localeCompare(String(a.id)))
          .slice(0, limit || 100);
      }
      return [];
    };
    return { run, get, all };
  }

  return { pragma: () => {}, exec: () => {}, prepare };
}

function initDb(dbPath) {
  try {
    const Database = require("better-sqlite3");
    const dir = path.dirname(dbPath);
    ensureDir(dir);
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS intents (
        intentId TEXT PRIMARY KEY,
        userAddress TEXT NOT NULL,
        payload TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipts (
        intentId TEXT PRIMARY KEY,
        userAddress TEXT NOT NULL,
        payload TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quotes (
        id TEXT PRIMARY KEY,
        userAddress TEXT,
        payload TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commitments (
        commitment TEXT PRIMARY KEY,
        idx INTEGER NOT NULL,
        txHash TEXT,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notes (
        noteId TEXT PRIMARY KEY,
        ownerAddress TEXT NOT NULL,
        commitment TEXT NOT NULL,
        txHash TEXT,
        payloadEnc TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deposit_sessions (
        sessionId TEXT PRIMARY KEY,
        sessionToken TEXT NOT NULL,
        idempotencyKey TEXT UNIQUE NOT NULL,
        depositor TEXT NOT NULL,
        mode TEXT NOT NULL,
        token TEXT,
        amount TEXT,
        assetId TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deposit_tx_receipts (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        txHash TEXT NOT NULL,
        receiptJson TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        ownerAddress TEXT NOT NULL,
        signingKey TEXT NOT NULL,
        pairBase TEXT NOT NULL,
        pairQuote TEXT NOT NULL,
        side TEXT NOT NULL,
        status TEXT NOT NULL,
        amount TEXT NOT NULL,
        limitPrice TEXT,
        remainingAmount TEXT NOT NULL,
        filledAmount TEXT NOT NULL,
        reservedAmount TEXT NOT NULL,
        nonce TEXT NOT NULL,
        replayKey TEXT NOT NULL,
        signatureHash TEXT NOT NULL,
        expiryTs INTEGER NOT NULL,
        encryptedPayload TEXT NOT NULL,
        normalizedPayload TEXT NOT NULL,
        matchRef TEXT,
        createdBy TEXT,
        updatedBy TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        UNIQUE(ownerAddress, nonce),
        UNIQUE(replayKey),
        UNIQUE(signatureHash)
      );
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_pair_side ON orders(pairBase, pairQuote, side);
      CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_orders_owner_signing ON orders(ownerAddress, signingKey);

      CREATE TABLE IF NOT EXISTS order_events (
        id TEXT PRIMARY KEY,
        orderId TEXT NOT NULL,
        eventType TEXT NOT NULL,
        fromStatus TEXT,
        toStatus TEXT,
        reason TEXT,
        actor TEXT,
        metadataJson TEXT,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_order_events_order_created ON order_events(orderId, createdAt);

      CREATE TABLE IF NOT EXISTS cancellations (
        id TEXT PRIMARY KEY,
        orderId TEXT NOT NULL UNIQUE,
        reason TEXT,
        actor TEXT NOT NULL,
        signatureHash TEXT NOT NULL,
        payloadJson TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cancellations_order ON cancellations(orderId);

      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        matchHash TEXT NOT NULL UNIQUE,
        executionKey TEXT NOT NULL,
        pairBase TEXT NOT NULL,
        pairQuote TEXT NOT NULL,
        makerOrderId TEXT NOT NULL,
        takerOrderId TEXT NOT NULL,
        makerSide TEXT NOT NULL,
        takerSide TEXT NOT NULL,
        executionPrice TEXT NOT NULL,
        quantity TEXT NOT NULL,
        status TEXT NOT NULL,
        decisionReasonCode TEXT,
        fheResultHash TEXT,
        fheDecisionHash TEXT,
        fheAttestationRef TEXT,
        metadataJson TEXT,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_matches_execution_key ON matches(executionKey);
      CREATE INDEX IF NOT EXISTS idx_matches_pair_created ON matches(pairBase, pairQuote, createdAt DESC);

      CREATE TABLE IF NOT EXISTS fills (
        id TEXT PRIMARY KEY,
        matchId TEXT NOT NULL,
        orderId TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity TEXT NOT NULL,
        price TEXT NOT NULL,
        isMaker INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fills_match ON fills(matchId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(orderId, createdAt);

      CREATE TABLE IF NOT EXISTS match_decisions (
        id TEXT PRIMARY KEY,
        traceId TEXT NOT NULL,
        takerOrderId TEXT NOT NULL,
        candidateOrderId TEXT,
        matchHash TEXT,
        executionKey TEXT,
        reasonCode TEXT NOT NULL,
        policyMode TEXT NOT NULL,
        fheDecisionHash TEXT,
        fheResultHash TEXT,
        fheAttestationRef TEXT,
        detailsJson TEXT,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_match_decisions_taker_created ON match_decisions(takerOrderId, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_match_decisions_candidate_created ON match_decisions(candidateOrderId, createdAt DESC);

      CREATE TABLE IF NOT EXISTS settlement_executions (
        executionId TEXT PRIMARY KEY,
        matchHash TEXT NOT NULL UNIQUE,
        executionKey TEXT NOT NULL,
        status TEXT NOT NULL,
        attemptCount INTEGER NOT NULL,
        txHash TEXT,
        traceId TEXT NOT NULL,
        fallbackMode TEXT,
        fallbackReasonCode TEXT,
        errorCode TEXT,
        errorMessage TEXT,
        payloadJson TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        lastAttemptAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_settlement_exec_status_updated ON settlement_executions(status, updatedAt DESC);

      CREATE TABLE IF NOT EXISTS settlement_events (
        id TEXT PRIMARY KEY,
        executionId TEXT NOT NULL,
        matchHash TEXT NOT NULL,
        traceId TEXT NOT NULL,
        eventType TEXT NOT NULL,
        reasonCode TEXT,
        detailsJson TEXT,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_settlement_events_execution_created ON settlement_events(executionId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_settlement_events_match_created ON settlement_events(matchHash, createdAt);

      CREATE TABLE IF NOT EXISTS compliance_decisions (
        id TEXT PRIMARY KEY,
        phase TEXT NOT NULL,
        action TEXT NOT NULL,
        orderId TEXT,
        actorRef TEXT,
        counterpartyRef TEXT,
        matchHash TEXT,
        executionKey TEXT,
        executionId TEXT,
        traceId TEXT NOT NULL,
        reasonCode TEXT NOT NULL,
        policyMode TEXT NOT NULL,
        policyVersion TEXT NOT NULL,
        evidenceRef TEXT,
        providerResponseHash TEXT,
        detailsJson TEXT,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_compliance_decisions_order_created ON compliance_decisions(orderId, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_compliance_decisions_match_created ON compliance_decisions(matchHash, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_compliance_decisions_execution_created ON compliance_decisions(executionId, createdAt DESC);

      CREATE TABLE IF NOT EXISTS attestation_decisions (
        id TEXT PRIMARY KEY,
        matchHash TEXT NOT NULL,
        executionKey TEXT NOT NULL,
        executionId TEXT,
        traceId TEXT NOT NULL,
        policyVersion TEXT NOT NULL,
        requiredQuorumBps INTEGER NOT NULL,
        valid INTEGER NOT NULL,
        reasonCode TEXT,
        signerCount INTEGER NOT NULL,
        signerSetHash TEXT,
        detailsJson TEXT,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attestation_decisions_match_created ON attestation_decisions(matchHash, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_attestation_decisions_execution_created ON attestation_decisions(executionId, createdAt DESC);
    `);
    return db;
  } catch (e) {
    console.warn("Using JSON file storage (better-sqlite3 unavailable on this system).");
    return initDbJson(dbPath);
  }
}

function saveIntent(db, intentId, userAddress, payload) {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO intents(intentId, userAddress, payload, createdAt) VALUES (?, ?, ?, ?)"
  );
  stmt.run(intentId, userAddress, JSON.stringify(payload), Date.now());
}

function getIntent(db, intentId) {
  const row = db.prepare("SELECT * FROM intents WHERE intentId = ?").get(intentId);
  if (!row) return null;
  return { intentId: row.intentId, userAddress: row.userAddress, payload: JSON.parse(row.payload) };
}

function saveReceipt(db, intentId, userAddress, payload) {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO receipts(intentId, userAddress, payload, createdAt) VALUES (?, ?, ?, ?)"
  );
  stmt.run(intentId, userAddress, JSON.stringify(payload), Date.now());
}

function getReceipt(db, intentId) {
  const row = db.prepare("SELECT * FROM receipts WHERE intentId = ?").get(intentId);
  if (!row) return null;
  return JSON.parse(row.payload);
}

function listReceipts(db, userAddress, limit = 50) {
  const rows = db
    .prepare(
      "SELECT payload FROM receipts WHERE userAddress = ? ORDER BY createdAt DESC LIMIT ?"
    )
    .all(userAddress, limit);
  return rows.map((r) => JSON.parse(r.payload));
}

function saveQuote(db, id, userAddress, payload) {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO quotes(id, userAddress, payload, createdAt) VALUES (?, ?, ?, ?)"
  );
  stmt.run(id, userAddress || null, JSON.stringify(payload), Date.now());
}

function saveCommitment(db, idx, commitment, txHash) {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO commitments(commitment, idx, txHash, createdAt) VALUES (?, ?, ?, ?)"
  );
  stmt.run(commitment, idx, txHash || null, Date.now());
}

function listCommitments(db) {
  return db.prepare("SELECT commitment, idx FROM commitments ORDER BY idx ASC").all();
}

function getCommitment(db, commitment) {
  return db.prepare("SELECT commitment, idx FROM commitments WHERE commitment = ?").get(commitment);
}

function exportAll(db) {
  const intents = db.prepare("SELECT payload FROM intents ORDER BY createdAt DESC").all();
  const receipts = db.prepare("SELECT payload FROM receipts ORDER BY createdAt DESC").all();
  const quotes = db.prepare("SELECT payload FROM quotes ORDER BY createdAt DESC").all();
  const commitments = db.prepare("SELECT commitment, idx, txHash, createdAt FROM commitments ORDER BY idx ASC").all();
  const notes = db
    .prepare("SELECT noteId, ownerAddress, commitment, txHash, createdAt, updatedAt FROM notes ORDER BY createdAt DESC")
    .all();
  return {
    intents: intents.map((r) => JSON.parse(r.payload)),
    receipts: receipts.map((r) => JSON.parse(r.payload)),
    quotes: quotes.map((r) => JSON.parse(r.payload)),
    commitments,
    notes
  };
}

function saveEncryptedNote(db, noteId, ownerAddress, commitment, txHash, payloadEnc) {
  const now = Date.now();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO notes(noteId, ownerAddress, commitment, txHash, payloadEnc, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  stmt.run(noteId, ownerAddress, commitment, txHash || null, payloadEnc, now, now);
}

function getEncryptedNote(db, noteId) {
  return db
    .prepare("SELECT noteId, ownerAddress, commitment, txHash, payloadEnc, createdAt, updatedAt FROM notes WHERE noteId = ?")
    .get(noteId);
}

function findEncryptedNoteByCommitment(db, commitment) {
  return db
    .prepare(
      "SELECT noteId, ownerAddress, commitment, txHash, payloadEnc, createdAt, updatedAt FROM notes WHERE commitment = ?"
    )
    .get(commitment);
}

function listEncryptedNotesByOwner(db, ownerAddress, limit = 50) {
  return db
    .prepare(
      "SELECT noteId, ownerAddress, commitment, txHash, payloadEnc, createdAt, updatedAt FROM notes WHERE ownerAddress = ? ORDER BY createdAt DESC LIMIT ?"
    )
    .all(ownerAddress, limit);
}

function saveDepositSession(db, row) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO deposit_sessions(
      sessionId, sessionToken, idempotencyKey, depositor, mode, token, amount, assetId, status, payload, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    row.sessionId,
    row.sessionToken,
    row.idempotencyKey,
    row.depositor,
    row.mode,
    row.token ?? null,
    row.amount ?? null,
    row.assetId,
    row.status,
    typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload ?? {}),
    row.createdAt,
    row.updatedAt
  );
}

function getDepositSessionByIdempotencyKey(db, idempotencyKey) {
  const row = db.prepare("SELECT * FROM deposit_sessions WHERE idempotencyKey = ?").get(idempotencyKey);
  if (!row) return null;
  return { ...row, payload: JSON.parse(row.payload) };
}

function getDepositSessionBySessionId(db, sessionId) {
  const row = db.prepare("SELECT * FROM deposit_sessions WHERE sessionId = ?").get(sessionId);
  if (!row) return null;
  return { ...row, payload: JSON.parse(row.payload) };
}

function saveDepositTxReceipt(db, { id, sessionId, txHash, receiptJson }) {
  const stmt = db.prepare(
    "INSERT INTO deposit_tx_receipts(id, sessionId, txHash, receiptJson, createdAt) VALUES (?, ?, ?, ?, ?)"
  );
  stmt.run(id, sessionId, txHash, receiptJson, Date.now());
}

function saveInternalOrder(db, row) {
  const stmt = db.prepare(
    `INSERT INTO orders(
      id, ownerAddress, signingKey, pairBase, pairQuote, side, status, amount, limitPrice, remainingAmount,
      filledAmount, reservedAmount, nonce, replayKey, signatureHash, expiryTs, encryptedPayload, normalizedPayload,
      matchRef, createdBy, updatedBy, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    row.id,
    row.ownerAddress,
    row.signingKey,
    row.pairBase,
    row.pairQuote,
    row.side,
    row.status,
    row.amount,
    row.limitPrice ?? null,
    row.remainingAmount,
    row.filledAmount,
    row.reservedAmount,
    row.nonce,
    row.replayKey,
    row.signatureHash,
    row.expiryTs,
    row.encryptedPayload,
    typeof row.normalizedPayload === "string" ? row.normalizedPayload : JSON.stringify(row.normalizedPayload || {}),
    row.matchRef ?? null,
    row.createdBy ?? null,
    row.updatedBy ?? null,
    row.createdAt,
    row.updatedAt
  );
}

function updateInternalOrderState(db, row) {
  const stmt = db.prepare(
    `UPDATE orders
     SET status = ?, remainingAmount = ?, filledAmount = ?, reservedAmount = ?, matchRef = ?, updatedBy = ?, updatedAt = ?
     WHERE id = ?`
  );
  stmt.run(
    row.status,
    row.remainingAmount,
    row.filledAmount,
    row.reservedAmount,
    row.matchRef ?? null,
    row.updatedBy ?? null,
    row.updatedAt,
    row.id
  );
}

function getInternalOrderById(db, id) {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!row) return null;
  return {
    ...row,
    normalizedPayload: JSON.parse(row.normalizedPayload),
  };
}

function getInternalOrderByReplayKey(db, replayKey) {
  const row = db.prepare("SELECT * FROM orders WHERE replayKey = ?").get(replayKey);
  if (!row) return null;
  return {
    ...row,
    normalizedPayload: JSON.parse(row.normalizedPayload),
  };
}

function getInternalOrderByOwnerNonce(db, ownerAddress, nonce) {
  const row = db.prepare("SELECT * FROM orders WHERE ownerAddress = ? AND nonce = ?").get(ownerAddress, nonce);
  if (!row) return null;
  return {
    ...row,
    normalizedPayload: JSON.parse(row.normalizedPayload),
  };
}

function listInternalOrders(db, { status, limit = 50, offset = 0 } = {}) {
  const rows = status
    ? db
      .prepare(
        "SELECT * FROM orders WHERE status = ? ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?"
      )
      .all(status, limit, offset)
    : db
      .prepare("SELECT * FROM orders ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?")
      .all(limit, offset);
  return rows.map((row) => ({
    ...row,
    normalizedPayload: JSON.parse(row.normalizedPayload),
  }));
}

function saveOrderEvent(db, row) {
  const stmt = db.prepare(
    `INSERT INTO order_events(
      id, orderId, eventType, fromStatus, toStatus, reason, actor, metadataJson, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    row.id,
    row.orderId,
    row.eventType,
    row.fromStatus ?? null,
    row.toStatus ?? null,
    row.reason ?? null,
    row.actor ?? null,
    typeof row.metadataJson === "string" ? row.metadataJson : JSON.stringify(row.metadataJson || {}),
    row.createdAt
  );
}

function listOrderEvents(db, orderId) {
  const rows = db
    .prepare(
      "SELECT id, orderId, eventType, fromStatus, toStatus, reason, actor, metadataJson, createdAt FROM order_events WHERE orderId = ? ORDER BY createdAt ASC, id ASC"
    )
    .all(orderId);
  return rows.map((row) => ({
    ...row,
    metadataJson: JSON.parse(row.metadataJson || "{}"),
  }));
}

function saveCancellation(db, row) {
  const stmt = db.prepare(
    "INSERT INTO cancellations(id, orderId, reason, actor, signatureHash, payloadJson, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  stmt.run(
    row.id,
    row.orderId,
    row.reason ?? null,
    row.actor,
    row.signatureHash,
    typeof row.payloadJson === "string" ? row.payloadJson : JSON.stringify(row.payloadJson || {}),
    row.createdAt
  );
}

function isSqliteDb(db) {
  return typeof db?.transaction === "function";
}

function listInternalOrdersForMatching(db) {
  const rows = db.prepare("SELECT * FROM orders ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?").all(1000000, 0);
  return rows.map((row) => ({
    ...row,
    normalizedPayload: typeof row.normalizedPayload === "string" ? JSON.parse(row.normalizedPayload) : row.normalizedPayload,
  }));
}

function compareAndSetInternalOrderState(db, row) {
  const fromStatuses = Array.isArray(row.fromStatuses) ? row.fromStatuses : [];
  if (fromStatuses.length === 0) return false;
  if (isSqliteDb(db)) {
    const placeholders = fromStatuses.map(() => "?").join(", ");
    const sql =
      `UPDATE orders
       SET status = ?, remainingAmount = ?, filledAmount = ?, reservedAmount = ?, matchRef = ?, updatedBy = ?, updatedAt = ?
       WHERE id = ? AND status IN (${placeholders})`;
    const params = [
      row.status,
      row.remainingAmount,
      row.filledAmount,
      row.reservedAmount,
      row.matchRef ?? null,
      row.updatedBy ?? null,
      row.updatedAt,
      row.id,
      ...fromStatuses,
    ];
    const result = db.prepare(sql).run(...params);
    return Number(result?.changes || 0) > 0;
  }

  const existing = getInternalOrderById(db, row.id);
  if (!existing || !fromStatuses.includes(existing.status)) return false;
  updateInternalOrderState(db, row);
  return true;
}

function saveMatch(db, row) {
  const stmt = db.prepare(
    `INSERT INTO matches(
      id, matchHash, executionKey, pairBase, pairQuote, makerOrderId, takerOrderId,
      makerSide, takerSide, executionPrice, quantity, status, decisionReasonCode, fheResultHash, fheDecisionHash, fheAttestationRef, metadataJson, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    row.id,
    row.matchHash,
    row.executionKey,
    row.pairBase,
    row.pairQuote,
    row.makerOrderId,
    row.takerOrderId,
    row.makerSide,
    row.takerSide,
    row.executionPrice,
    row.quantity,
    row.status,
    row.decisionReasonCode ?? null,
    row.fheResultHash ?? null,
    row.fheDecisionHash ?? null,
    row.fheAttestationRef ?? null,
    typeof row.metadataJson === "string" ? row.metadataJson : JSON.stringify(row.metadataJson || {}),
    row.createdAt
  );
}

function getMatchByHash(db, matchHash) {
  const row = db.prepare("SELECT * FROM matches WHERE matchHash = ?").get(matchHash);
  if (!row) return null;
  return {
    ...row,
    metadataJson: typeof row.metadataJson === "string" ? JSON.parse(row.metadataJson || "{}") : (row.metadataJson || {}),
  };
}

function saveFill(db, row) {
  const stmt = db.prepare(
    "INSERT INTO fills(id, matchId, orderId, side, quantity, price, isMaker, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  stmt.run(
    row.id,
    row.matchId,
    row.orderId,
    row.side,
    row.quantity,
    row.price,
    row.isMaker ? 1 : 0,
    row.createdAt
  );
}

function listFillsByMatch(db, matchId) {
  const rows = db
    .prepare("SELECT id, matchId, orderId, side, quantity, price, isMaker, createdAt FROM fills WHERE matchId = ? ORDER BY createdAt ASC, id ASC")
    .all(matchId);
  return rows.map((row) => ({
    ...row,
    isMaker: Boolean(row.isMaker),
  }));
}

function saveMatchDecision(db, row) {
  const stmt = db.prepare(
    `INSERT INTO match_decisions(
      id, traceId, takerOrderId, candidateOrderId, matchHash, executionKey, reasonCode, policyMode,
      fheDecisionHash, fheResultHash, fheAttestationRef, detailsJson, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    row.id,
    row.traceId,
    row.takerOrderId,
    row.candidateOrderId ?? null,
    row.matchHash ?? null,
    row.executionKey ?? null,
    row.reasonCode,
    row.policyMode,
    row.fheDecisionHash ?? null,
    row.fheResultHash ?? null,
    row.fheAttestationRef ?? null,
    typeof row.detailsJson === "string" ? row.detailsJson : JSON.stringify(row.detailsJson || {}),
    row.createdAt
  );
}

function listMatchDecisionsByOrder(db, orderId, limit = 100) {
  const rows = db
    .prepare(
      "SELECT id, traceId, takerOrderId, candidateOrderId, matchHash, executionKey, reasonCode, policyMode, fheDecisionHash, fheResultHash, fheAttestationRef, detailsJson, createdAt FROM match_decisions WHERE takerOrderId = ? OR candidateOrderId = ? ORDER BY createdAt DESC, id DESC LIMIT ?"
    )
    .all(orderId, orderId, limit);
  return rows.map((row) => ({
    ...row,
    detailsJson: typeof row.detailsJson === "string" ? JSON.parse(row.detailsJson || "{}") : (row.detailsJson || {}),
  }));
}

function createSettlementExecutionIfAbsent(db, row) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO settlement_executions(
      executionId, matchHash, executionKey, status, attemptCount, txHash, traceId, fallbackMode,
      fallbackReasonCode, errorCode, errorMessage, payloadJson, createdAt, updatedAt, lastAttemptAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    row.executionId,
    row.matchHash,
    row.executionKey,
    row.status,
    row.attemptCount,
    row.txHash ?? null,
    row.traceId,
    row.fallbackMode ?? null,
    row.fallbackReasonCode ?? null,
    row.errorCode ?? null,
    row.errorMessage ?? null,
    typeof row.payloadJson === "string" ? row.payloadJson : JSON.stringify(row.payloadJson || {}),
    row.createdAt,
    row.updatedAt,
    row.lastAttemptAt ?? null
  );
}

function updateSettlementExecution(db, row) {
  const stmt = db.prepare(
    `UPDATE settlement_executions
     SET status = ?, attemptCount = ?, txHash = ?, traceId = ?, fallbackMode = ?, fallbackReasonCode = ?, errorCode = ?, errorMessage = ?, payloadJson = ?, updatedAt = ?, lastAttemptAt = ?
     WHERE executionId = ?`
  );
  stmt.run(
    row.status,
    row.attemptCount,
    row.txHash ?? null,
    row.traceId,
    row.fallbackMode ?? null,
    row.fallbackReasonCode ?? null,
    row.errorCode ?? null,
    row.errorMessage ?? null,
    typeof row.payloadJson === "string" ? row.payloadJson : JSON.stringify(row.payloadJson || {}),
    row.updatedAt,
    row.lastAttemptAt ?? null,
    row.executionId
  );
}

function getSettlementExecutionByMatchHash(db, matchHash) {
  const row = db.prepare("SELECT * FROM settlement_executions WHERE matchHash = ?").get(matchHash);
  if (!row) return null;
  return {
    ...row,
    payloadJson: typeof row.payloadJson === "string" ? JSON.parse(row.payloadJson || "{}") : (row.payloadJson || {}),
  };
}

function getSettlementExecutionById(db, executionId) {
  const row = db.prepare("SELECT * FROM settlement_executions WHERE executionId = ?").get(executionId);
  if (!row) return null;
  return {
    ...row,
    payloadJson: typeof row.payloadJson === "string" ? JSON.parse(row.payloadJson || "{}") : (row.payloadJson || {}),
  };
}

function saveSettlementEvent(db, row) {
  const stmt = db.prepare(
    `INSERT INTO settlement_events(
      id, executionId, matchHash, traceId, eventType, reasonCode, detailsJson, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    row.id,
    row.executionId,
    row.matchHash,
    row.traceId,
    row.eventType,
    row.reasonCode ?? null,
    typeof row.detailsJson === "string" ? row.detailsJson : JSON.stringify(row.detailsJson || {}),
    row.createdAt
  );
}

function listSettlementEventsByExecutionId(db, executionId, limit = 200) {
  const rows = db
    .prepare(
      "SELECT id, executionId, matchHash, traceId, eventType, reasonCode, detailsJson, createdAt FROM settlement_events WHERE executionId = ? ORDER BY createdAt ASC, id ASC LIMIT ?"
    )
    .all(executionId, limit);
  return rows.map((row) => ({
    ...row,
    detailsJson: typeof row.detailsJson === "string" ? JSON.parse(row.detailsJson || "{}") : (row.detailsJson || {}),
  }));
}

function saveComplianceDecision(db, row) {
  const stmt = db.prepare(
    `INSERT INTO compliance_decisions(
      id, phase, action, orderId, actorRef, counterpartyRef, matchHash, executionKey, executionId,
      traceId, reasonCode, policyMode, policyVersion, evidenceRef, providerResponseHash, detailsJson, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    row.id,
    row.phase,
    row.action,
    row.orderId ?? null,
    row.actorRef ?? null,
    row.counterpartyRef ?? null,
    row.matchHash ?? null,
    row.executionKey ?? null,
    row.executionId ?? null,
    row.traceId,
    row.reasonCode,
    row.policyMode,
    row.policyVersion,
    row.evidenceRef ?? null,
    row.providerResponseHash ?? null,
    typeof row.detailsJson === "string" ? row.detailsJson : JSON.stringify(row.detailsJson || {}),
    row.createdAt
  );
}

function listComplianceDecisionsByOrder(db, orderId, limit = 200) {
  const rows = db
    .prepare(
      "SELECT * FROM compliance_decisions WHERE orderId = ? ORDER BY createdAt DESC, id DESC LIMIT ?"
    )
    .all(orderId, limit);
  return rows.map((row) => ({
    ...row,
    detailsJson: typeof row.detailsJson === "string" ? JSON.parse(row.detailsJson || "{}") : (row.detailsJson || {}),
  }));
}

function listComplianceDecisionsByMatch(db, matchHash, limit = 200) {
  const rows = db
    .prepare(
      "SELECT * FROM compliance_decisions WHERE matchHash = ? ORDER BY createdAt DESC, id DESC LIMIT ?"
    )
    .all(matchHash, limit);
  return rows.map((row) => ({
    ...row,
    detailsJson: typeof row.detailsJson === "string" ? JSON.parse(row.detailsJson || "{}") : (row.detailsJson || {}),
  }));
}

function listComplianceDecisionsByExecutionId(db, executionId, limit = 200) {
  const rows = db
    .prepare(
      "SELECT * FROM compliance_decisions WHERE executionId = ? ORDER BY createdAt DESC, id DESC LIMIT ?"
    )
    .all(executionId, limit);
  return rows.map((row) => ({
    ...row,
    detailsJson: typeof row.detailsJson === "string" ? JSON.parse(row.detailsJson || "{}") : (row.detailsJson || {}),
  }));
}

function saveAttestationDecision(db, row) {
  const stmt = db.prepare(
    `INSERT INTO attestation_decisions(
      id, matchHash, executionKey, executionId, traceId, policyVersion, requiredQuorumBps, valid,
      reasonCode, signerCount, signerSetHash, detailsJson, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    row.id,
    row.matchHash,
    row.executionKey,
    row.executionId ?? null,
    row.traceId,
    row.policyVersion,
    row.requiredQuorumBps,
    row.valid ? 1 : 0,
    row.reasonCode ?? null,
    row.signerCount ?? 0,
    row.signerSetHash ?? null,
    typeof row.detailsJson === "string" ? row.detailsJson : JSON.stringify(row.detailsJson || {}),
    row.createdAt
  );
}

function listAttestationDecisionsByMatch(db, matchHash, limit = 100) {
  const rows = db
    .prepare("SELECT * FROM attestation_decisions WHERE matchHash = ? ORDER BY createdAt DESC, id DESC LIMIT ?")
    .all(matchHash, limit);
  return rows.map((row) => ({
    ...row,
    valid: Boolean(row.valid),
    detailsJson: typeof row.detailsJson === "string" ? JSON.parse(row.detailsJson || "{}") : (row.detailsJson || {}),
  }));
}

function listAttestationDecisionsByExecutionId(db, executionId, limit = 100) {
  const rows = db
    .prepare("SELECT * FROM attestation_decisions WHERE executionId = ? ORDER BY createdAt DESC, id DESC LIMIT ?")
    .all(executionId, limit);
  return rows.map((row) => ({
    ...row,
    valid: Boolean(row.valid),
    detailsJson: typeof row.detailsJson === "string" ? JSON.parse(row.detailsJson || "{}") : (row.detailsJson || {}),
  }));
}

module.exports = {
  initDb,
  saveIntent,
  getIntent,
  saveReceipt,
  getReceipt,
  listReceipts,
  saveQuote,
  exportAll,
  saveCommitment,
  listCommitments,
  getCommitment,
  saveEncryptedNote,
  getEncryptedNote,
  findEncryptedNoteByCommitment,
  listEncryptedNotesByOwner,
  saveDepositSession,
  getDepositSessionByIdempotencyKey,
  getDepositSessionBySessionId,
  saveDepositTxReceipt
  ,
  saveInternalOrder,
  updateInternalOrderState,
  getInternalOrderById,
  getInternalOrderByReplayKey,
  getInternalOrderByOwnerNonce,
  listInternalOrders,
  saveOrderEvent,
  listOrderEvents,
  saveCancellation,
  listInternalOrdersForMatching,
  compareAndSetInternalOrderState,
  saveMatch,
  getMatchByHash,
  saveFill,
  listFillsByMatch,
  saveMatchDecision,
  listMatchDecisionsByOrder,
  createSettlementExecutionIfAbsent,
  updateSettlementExecution,
  getSettlementExecutionByMatchHash,
  getSettlementExecutionById,
  saveSettlementEvent,
  listSettlementEventsByExecutionId,
  saveComplianceDecision,
  listComplianceDecisionsByOrder,
  listComplianceDecisionsByMatch,
  listComplianceDecisionsByExecutionId,
  saveAttestationDecision,
  listAttestationDecisionsByMatch,
  listAttestationDecisionsByExecutionId
};

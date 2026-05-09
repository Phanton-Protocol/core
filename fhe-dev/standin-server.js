/**
 * Minimal HTTP stand-in for a real FHE microservice.
 * Same routes as phantom-relayer-dashboard backend /fhe expects when proxying.
 *
 * Run: node fhe-dev/standin-server.js
 * Then: FHE_MODE=remote and FHE_SERVICE_URL=http://127.0.0.1:9100
 */

const http = require('http');
const { ethers } = require('ethers');

const PORT = Number(process.env.FHE_STANDIN_PORT || 9100);

// Phase 3: signed match attestation. Defaults to the same dev key used by
// the python TenSEAL service (0x11..11) so test harnesses can recover the
// signer address deterministically. In real deployments set
// MATCHING_SERVICE_PRIVATE_KEY to a key whose address is registered with the
// on-chain operator quorum.
const MATCHING_SERVICE_PRIVATE_KEY =
  process.env.MATCHING_SERVICE_PRIVATE_KEY || '0x' + '11'.repeat(32);
const matchingSigner = new ethers.Wallet(MATCHING_SERVICE_PRIVATE_KEY);

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function signingKeyFromHex(hex) {
  return new ethers.SigningKey(hex);
}

function signDecisionDigest(digestHex) {
  const sk = signingKeyFromHex(matchingSigner.privateKey);
  const sig = sk.sign(digestHex);
  return ethers.Signature.from(sig).serialized;
}

function safeIntStr(value) {
  if (value === null || value === undefined) return '0';
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) return '0';
  return String(n);
}

function readPlaintextAmount(bundle, intent, key) {
  if (bundle && typeof bundle === 'object') {
    if (key === '_ckksAmount' && bundle.amount !== undefined) return Number(bundle.amount);
    if (key === '_ckksPrice' && bundle.limitPrice !== undefined) return Number(bundle.limitPrice);
    const blob = bundle[key];
    if (typeof blob === 'string' && blob.startsWith('0x')) {
      const hex = blob.slice(2);
      try {
        const utf8 = Buffer.from(hex, 'hex').toString('utf8');
        const parsed = Number(utf8);
        if (Number.isFinite(parsed)) return parsed;
      } catch {
        // fall through to BigInt fallback
      }
      try {
        if (hex.length > 0 && hex.length <= 64) return Number(BigInt('0x' + hex));
      } catch {
        // ignore
      }
    }
  }
  if (key === '_ckksAmount' && intent && intent.amount !== undefined) return Number(intent.amount);
  if (key === '_ckksPrice' && intent && intent.limitPrice !== undefined) return Number(intent.limitPrice);
  return 0;
}

function intentMissing(intent, label) {
  const required = ['user', 'side', 'inputAssetID', 'outputAssetID', 'amount', 'limitPrice'];
  const missing = required.filter((k) => intent?.[k] === undefined);
  if (missing.length) return `${label}_intent_missing_fields:${missing.join(',')}`;
  return null;
}

function internalMatchCompare(body) {
  const maker = body?.maker || {};
  const taker = body?.taker || {};
  const makerIntent = maker.intent || {};
  const takerIntent = taker.intent || {};
  const err = intentMissing(makerIntent, 'maker') || intentMissing(takerIntent, 'taker');
  if (err) return { status: 400, body: { matched: false, reason: err } };

  const makerSide = Number(makerIntent.side);
  const takerSide = Number(takerIntent.side);
  if (![0, 1].includes(makerSide) || ![0, 1].includes(takerSide) || makerSide === takerSide) {
    return { status: 200, body: { matched: false, reason: 'side_mismatch' } };
  }
  if (
    String(makerIntent.inputAssetID) !== String(takerIntent.outputAssetID) ||
    String(makerIntent.outputAssetID) !== String(takerIntent.inputAssetID)
  ) {
    return { status: 200, body: { matched: false, reason: 'asset_mismatch' } };
  }
  const now = Math.floor(Date.now() / 1000);
  for (const [label, intent] of [['maker', makerIntent], ['taker', takerIntent]]) {
    if (intent.deadline !== undefined && Number(intent.deadline) <= now) {
      return { status: 200, body: { matched: false, reason: `${label}_expired` } };
    }
  }
  const makerAmount = readPlaintextAmount(maker.ciphertext, makerIntent, '_ckksAmount');
  const takerAmount = readPlaintextAmount(taker.ciphertext, takerIntent, '_ckksAmount');
  const makerPrice = readPlaintextAmount(maker.ciphertext, makerIntent, '_ckksPrice');
  const takerPrice = readPlaintextAmount(taker.ciphertext, takerIntent, '_ckksPrice');
  const sellPrice = makerSide === 0 ? makerPrice : takerPrice;
  const buyPrice = makerSide === 0 ? takerPrice : makerPrice;
  if (buyPrice < sellPrice) {
    return { status: 200, body: { matched: false, reason: 'price_cross_failed' } };
  }
  const execAmount = Math.min(Math.max(0, makerAmount), Math.max(0, takerAmount));
  if (execAmount <= 0) {
    return { status: 200, body: { matched: false, reason: 'amount_zero' } };
  }
  const execPrice = (sellPrice + buyPrice) / 2;
  const tsMs = String(Date.now());
  const canonical = {
    v: 'phantom-fhe-attestation/v1',
    matched: true,
    makerCiphertextHash: String(makerIntent.ciphertextHash || ''),
    takerCiphertextHash: String(takerIntent.ciphertextHash || ''),
    makerUser: String(makerIntent.user || ''),
    takerUser: String(takerIntent.user || ''),
    makerNonce: String(makerIntent.nonce ?? '0'),
    takerNonce: String(takerIntent.nonce ?? '0'),
    inputAssetID: String(takerIntent.inputAssetID),
    outputAssetID: String(takerIntent.outputAssetID),
    execAmount: safeIntStr(execAmount),
    execPrice: safeIntStr(execPrice),
    ts: tsMs,
  };
  const digestHex = ethers.keccak256(ethers.toUtf8Bytes(stableStringify(canonical)));
  const signatureHex = signDecisionDigest(digestHex);
  return {
    status: 200,
    body: {
      matched: true,
      reason: null,
      result: {
        execPrice: canonical.execPrice,
        execAmount: canonical.execAmount,
        ts: tsMs,
      },
      bindings: {
        makerCiphertextHash: canonical.makerCiphertextHash,
        takerCiphertextHash: canonical.takerCiphertextHash,
        makerUser: canonical.makerUser,
        takerUser: canonical.takerUser,
      },
      attestation: {
        decisionHash: digestHex,
        signature: signatureHex,
        signerAddress: matchingSigner.address,
        canonical,
      },
    },
  };
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function matchOrders(order1, order2) {
  const assetsMatch =
    order1.inputAssetID === order2.outputAssetID &&
    order1.outputAssetID === order2.inputAssetID;
  if (!assetsMatch) {
    return {
      matched: false,
      fheEncryptedResult: '0x',
      executionId: ethers.ZeroHash,
    };
  }
  const executionId = ethers.keccak256(
    ethers.concat([
      ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(String(order1.fheEncryptedInputAmount)))),
      ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(String(order2.fheEncryptedInputAmount)))),
      ethers.toUtf8Bytes(Date.now().toString()),
    ])
  );
  const fheEncryptedResult = ethers.hexlify(ethers.toUtf8Bytes(`STANDIN_FHE:${executionId}`));
  return { matched: true, fheEncryptedResult, executionId };
}

function compatibility(taker, candidate) {
  if (!taker || !candidate) {
    return { compatible: false, code: "invalid_payload", attestationRef: null };
  }
  const sidesOpposite = String(taker.side || "") !== String(candidate.side || "");
  const pairMatch =
    String(taker.pairBase || "") === String(candidate.pairBase || "") &&
    String(taker.pairQuote || "") === String(candidate.pairQuote || "");
  const compatible = sidesOpposite && pairMatch;
  return {
    compatible,
    code: compatible ? "ok" : "reject_pair_or_side",
    attestationRef: `standin:${Date.now()}`,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  try {
    if (req.method === 'GET' && path === '/public-key') {
      return json(res, 200, { publicKey: ethers.hexlify(ethers.randomBytes(32)) });
    }

    if (req.method === 'POST' && path === '/encrypt') {
      const body = await readBody(req);
      return json(res, 200, { ciphertext: body, standin: true });
    }

    if (req.method === 'POST' && path === '/match') {
      const body = await readBody(req);
      const { order1, order2 } = body;
      if (!order1 || !order2) return json(res, 400, { error: 'Missing order data' });
      return json(res, 200, matchOrders(order1, order2));
    }

    if (req.method === 'POST' && path === '/compute') {
      const body = await readBody(req);
      if (!body.operation || !body.encryptedInputs) {
        return json(res, 400, { error: 'Missing operation or inputs' });
      }
      return json(res, 200, {
        operation: body.operation,
        fheEncryptedResult: ethers.hexlify(ethers.randomBytes(32)),
        executionId: ethers.keccak256(ethers.toUtf8Bytes(Date.now().toString())),
        standin: true,
      });
    }

    if (req.method === 'POST' && path === '/compatibility') {
      const body = await readBody(req);
      return json(res, 200, compatibility(body?.taker, body?.candidate));
    }

    if (req.method === 'GET' && path === '/attestation-pubkey') {
      return json(res, 200, {
        signerAddress: matchingSigner.address,
        scheme: 'ECDSA secp256k1',
        library: 'standin',
      });
    }

    if (req.method === 'POST' && path === '/internal-match/compare') {
      const body = await readBody(req);
      const out = internalMatchCompare(body);
      return json(res, out.status, out.body);
    }

    if (req.method === 'GET' && path === '/health') {
      return json(res, 200, { status: 'ok', service: 'fhe-standin' });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: e.message || 'error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`FHE stand-in listening on http://127.0.0.1:${PORT}`);
});

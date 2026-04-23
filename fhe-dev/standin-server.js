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

/**
 * Module 7 — structured logging for relayer RPC / tx failures + revert decoding.
 * Module 8 — also records short error lines for /relayer/dashboard.
 */
const { ethers } = require("ethers");
const { pushError } = require("./relayerActivityBuffer");

const poolIface = new ethers.Interface([
  "error PoolErr(uint8 code)",
  "error SP()",
  "error Panic(uint256)",
]);

function decodeRevertData(data) {
  if (!data || typeof data !== "string" || !data.startsWith("0x")) return null;
  try {
    const parsed = poolIface.parseError(data);
    if (parsed?.name === "PoolErr") {
      return `PoolErr(${(parsed.args[0]).toString()})`;
    }
    if (parsed?.name === "SP") {
      return "SP()";
    }
    if (parsed?.name === "Panic") {
      return `Panic(${(parsed.args[0]).toString()})`;
    }
  } catch (_) {
    /* not PoolErr */
  }
  try {
    if (data.length > 10) {
      const body = ethers.dataSlice(data, 4);
      const reason = ethers.AbiCoder.defaultAbiCoder().decode(["string"], body);
      if (reason?.[0]) return `Error(string): ${reason[0]}`;
    }
  } catch (_) {
    /* ignore */
  }
  return `raw:${data}`;
}

/**
 * @param {string} phase e.g. shieldedSwapJoinSplit
 * @param {unknown} err ethers CallException or generic Error
 */
function logRelayerOnchainFailure(phase, err) {
  const e = err && typeof err === "object" ? err : {};
  const code = e.code;
  const shortMessage = e.shortMessage;
  const reason = e.reason;
  let revertData = e.data;
  if (!revertData && e.error && typeof e.error === "object") {
    revertData = e.error.data;
  }
  const decoded = revertData ? decodeRevertData(revertData) : null;
  console.error(`[relayer:onchain] phase=${phase} code=${code || "n/a"} shortMessage=${shortMessage || reason || e.message || err}`);
  if (decoded) console.error(`[relayer:onchain] decoded=${decoded}`);
  try {
    pushError({
      phase,
      message: decoded ? `${e.message || shortMessage || reason || ""} (${decoded})` : e.message || shortMessage || reason || String(err),
      code: code
    });
  } catch (_) {
    /* ignore buffer failures */
  }
}

function logRelayerRpcFailure(phase, err) {
  const e = err && typeof err === "object" ? err : {};
  console.error(
    `[relayer:rpc] phase=${phase} code=${e.code || "n/a"} message=${e.message || String(err)}`
  );
  try {
    pushError({ phase: `rpc:${phase}`, message: e.message || String(err), code: e.code });
  } catch (_) {
    /* ignore */
  }
}

function logProofFailure(phase, err) {
  const msg = err && err.message ? err.message : String(err);
  console.error(`[relayer:proof] phase=${phase} message=${msg}`);
  try {
    pushError({ phase: `proof:${phase}`, message: msg });
  } catch (_) {
    /* ignore */
  }
}

module.exports = {
  decodeRevertData,
  logRelayerOnchainFailure,
  logRelayerRpcFailure,
  logProofFailure,
};

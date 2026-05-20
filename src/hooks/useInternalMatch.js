// M8 — Path B Internal Match React hook.
//
// Owns the user-facing internal-match flow for `/trade`:
//   1. `enroll(signer)`    — one-time on-chain opt-in (`enrollInternalMatch`).
//   2. `submitInternalOrder({ side, amount, price, assetIn, assetOut })` —
//      encrypt order + dual EIP-712 sign + POST `/intent/internal`.
//   3. `cancelOrder(orderId, reason)` — EIP-712 cancel via `signCancel`.
//   4. `refreshEnrollment()`         — read backend enrollment row.
//   5. `refreshPendingNotes()`       — list spendable matched pending notes.
//   6. `refreshWithdrawPlan()`       — withdraw planner output (net + fee).
//
// HONEST PRIVACY NOTES SURFACED IN UI (matches PART B step 4):
//   - Off-chain order book is encrypted; matcher never reads amount/price.
//   - On-chain enrollment is visible; trade amounts only appear on-chain
//     at withdraw (v1). Full on-chain amount privacy is a v2 ZK circuit upgrade.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import {
  cancelInternalIntent,
  createInternalIntent,
  encryptFhe,
  getFhePublicKey,
  getInternalMatchEnrollment,
  getInternalMatchPendingNotes,
  getInternalMatchStatus,
  getInternalMatchWithdrawPlan,
  getRelayerConfig,
  prepareInternalMatchEnrollment,
  syncInternalMatchEnrollment,
} from "../api/phantomApi";
import {
  buildInternalIntentRequest,
  signCancel,
} from "../lib/internalMatchIntent.js";

const ENROLL_INTERNAL_ABI = [
  "function enrollInternalMatch(bytes32 enrollmentId, bytes encryptedPayload, bytes userSig) external",
  "function isInternalMatchEnrolled(address user) external view returns (bool)",
];

function symbolForAssetId(assets, id) {
  const list = Array.isArray(assets) ? assets : [];
  const hit = list.find((a) => String(a.assetId) === String(id));
  return hit ? String(hit.symbol).toUpperCase() : `ASSET#${id}`;
}

function ownerLc(addr) {
  try {
    return ethers.getAddress(addr).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * useInternalMatch — single source of truth for the `/trade` Internal Match tab.
 *
 * @param {{ signer?: any, address?: string, autoFetch?: boolean }} opts
 */
export default function useInternalMatch({ signer, address, autoFetch = true } = {}) {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [fheAvailable, setFheAvailable] = useState(null);
  const [enrollment, setEnrollment] = useState(null); // { enrolled, enrollmentId, txHash, ... } or null
  const [enrollmentLoaded, setEnrollmentLoaded] = useState(false);
  const [pendingNotes, setPendingNotes] = useState([]);
  const [withdrawPlan, setWithdrawPlan] = useState([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastOrder, setLastOrder] = useState(null);

  const ownerKey = useMemo(() => ownerLc(address || ""), [address]);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load relayer config + FHE availability.
  useEffect(() => {
    let cancelled = false;
    getRelayerConfig()
      .then((cfg) => { if (!cancelled) setConfig(cfg); })
      .catch((e) => { if (!cancelled) setConfigError(e?.message || String(e)); });
    getFhePublicKey()
      .then(() => { if (!cancelled) setFheAvailable(true); })
      .catch(() => { if (!cancelled) setFheAvailable(false); });
    return () => { cancelled = true; };
  }, []);

  const refreshEnrollment = useCallback(async () => {
    if (!ownerKey) {
      setEnrollment(null);
      setEnrollmentLoaded(true);
      return null;
    }
    try {
      const row = await getInternalMatchEnrollment(ethers.getAddress(ownerKey));
      if (!mountedRef.current) return row;
      setEnrollment(row);
      setEnrollmentLoaded(true);
      return row;
    } catch (e) {
      // 404 = not enrolled. Anything else surfaces as error but still resolves.
      const msg = e?.message || String(e);
      if (!mountedRef.current) return null;
      setEnrollment(null);
      setEnrollmentLoaded(true);
      if (!/404|enrollment_not_found/.test(msg)) {
        setError(msg);
      }
      return null;
    }
  }, [ownerKey]);

  const refreshPendingNotes = useCallback(async () => {
    if (!ownerKey) {
      setPendingNotes([]);
      return [];
    }
    try {
      const res = await getInternalMatchPendingNotes(ethers.getAddress(ownerKey));
      const list = Array.isArray(res?.pendingNotes) ? res.pendingNotes : [];
      if (!mountedRef.current) return list;
      setPendingNotes(list);
      return list;
    } catch (e) {
      if (!mountedRef.current) return [];
      const msg = e?.message || String(e);
      if (!/404/.test(msg)) setError(msg);
      setPendingNotes([]);
      return [];
    }
  }, [ownerKey]);

  const refreshWithdrawPlan = useCallback(async () => {
    if (!ownerKey) {
      setWithdrawPlan([]);
      return [];
    }
    try {
      const res = await getInternalMatchWithdrawPlan(ethers.getAddress(ownerKey));
      const list = Array.isArray(res?.pendingNotes) ? res.pendingNotes : [];
      if (!mountedRef.current) return list;
      setWithdrawPlan(list);
      return list;
    } catch (e) {
      if (!mountedRef.current) return [];
      const msg = e?.message || String(e);
      if (!/404/.test(msg)) setError(msg);
      setWithdrawPlan([]);
      return [];
    }
  }, [ownerKey]);

  useEffect(() => {
    if (!autoFetch) return undefined;
    refreshEnrollment();
    refreshPendingNotes();
    refreshWithdrawPlan();
    return undefined;
  }, [autoFetch, refreshEnrollment, refreshPendingNotes, refreshWithdrawPlan]);

  const isEnrolled = !!enrollment?.enrolled;

  /**
   * Enroll the connected wallet for Path B internal matching.
   *
   * Privacy posture: the AES key encrypting the enrollment payload is a
   * server-only secret (`PHANTOM_PROTOCOL_OWNER_DECRYPT_KEY_HEX`). We never
   * expose it to the browser — instead the relayer's `/internal-match/enroll-prepare`
   * endpoint returns ciphertext + messageHash; the wallet signs the messageHash
   * via EIP-191; the wallet then calls `enrollInternalMatch(...)` on the pool
   * (user pays gas).
   */
  const enroll = useCallback(
    async (signerOverride) => {
      setError("");
      setStatus("Preparing enrollment…");
      const useSigner = signerOverride || signer;
      if (!useSigner) {
        setError("Connect a wallet to enroll.");
        setStatus("");
        throw new Error("wallet_signer_required");
      }
      if (!config?.addresses?.shieldedPool) {
        setError("Relayer config missing pool address.");
        setStatus("");
        throw new Error("pool_address_unavailable");
      }
      setBusy(true);
      try {
        const userAddress = ethers.getAddress(await useSigner.getAddress());

        setStatus("Requesting encrypted enrollment payload from relayer…");
        const prep = await prepareInternalMatchEnrollment({
          userAddress,
          metadata: { agreed: true, ts: Date.now() },
        });
        if (!prep?.enrollmentId || !prep?.encryptedPayload || !prep?.messageHash) {
          throw new Error("enroll_prepare_invalid_response");
        }

        setStatus("Awaiting wallet signature for enrollment…");
        const userSig = await useSigner.signMessage(ethers.getBytes(prep.messageHash));

        setStatus("Submitting enrollInternalMatch tx (you pay gas)…");
        const pool = new ethers.Contract(
          config.addresses.shieldedPool,
          ENROLL_INTERNAL_ABI,
          useSigner
        );
        const tx = await pool.enrollInternalMatch(
          prep.enrollmentId,
          prep.encryptedPayload,
          userSig
        );
        setStatus(`Waiting for confirmation… (${tx.hash.slice(0, 10)}…)`);
        const receipt = await tx.wait();

        setStatus("Syncing enrollment with relayer…");
        const synced = await syncInternalMatchEnrollment({
          userAddress,
          enrollmentId: prep.enrollmentId,
          payloadHash: prep.payloadHash,
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          encryptedPayload: prep.encryptedPayload,
        });

        await refreshEnrollment();
        setStatus("Enrolled.");
        return { receipt, synced };
      } catch (e) {
        const msg = e?.message || String(e);
        setError(msg);
        setStatus("");
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [config, refreshEnrollment, signer]
  );

  const submitInternalOrder = useCallback(
    async (params) => {
      setError("");
      setStatus("Preparing internal match order…");
      if (!signer) {
        setError("Connect a wallet to submit an order.");
        setStatus("");
        throw new Error("wallet_signer_required");
      }
      if (!config?.chainId || !config?.addresses?.shieldedPool) {
        setError("Relayer config missing chainId / shieldedPool.");
        setStatus("");
        throw new Error("relayer_config_missing");
      }
      if (!isEnrolled) {
        setError("Enroll in Internal Match first.");
        setStatus("");
        throw new Error("enrollment_required");
      }

      const {
        side,
        amount,
        price,
        assetIn,
        assetOut,
        replayKey,
      } = params || {};
      const amountNum = Number(amount);
      const priceNum = Number(price);
      if (!Number.isFinite(amountNum) || amountNum <= 0) {
        setError("Invalid amount");
        setStatus("");
        throw new Error("invalid_amount");
      }
      if (!Number.isFinite(priceNum) || priceNum <= 0) {
        setError("Invalid price");
        setStatus("");
        throw new Error("invalid_price");
      }
      if (String(assetIn) === String(assetOut)) {
        setError("Asset in and asset out must differ.");
        setStatus("");
        throw new Error("asset_in_equals_out");
      }

      setBusy(true);
      try {
        setStatus("Encrypting amount + price via FHE service…");
        const encResult = await encryptFhe({
          amount: amountNum,
          limitPrice: priceNum,
          side,
          assetIn,
          assetOut,
          timestamp: Date.now(),
        });
        const ciphertext = encResult?.ciphertext ?? encResult?.encrypted ?? encResult;
        if (!ciphertext || (typeof ciphertext === "object" && !Object.keys(ciphertext).length)) {
          throw new Error("FHE encryption unavailable.");
        }

        setStatus("Awaiting wallet signature 1/2 (operator intent)…");
        const expirySec = Math.floor(Date.now() / 1000) + 3600;
        const operatorNonce = Date.now();
        const matchNonce = operatorNonce + 1;
        const body = await buildInternalIntentRequest({
          signer,
          chainId: config.chainId,
          verifyingContract: config.addresses.shieldedPool,
          side,
          baseAsset: symbolForAssetId(config.assets, assetIn),
          quoteAsset: symbolForAssetId(config.assets, assetOut),
          inputAssetID: assetIn,
          outputAssetID: assetOut,
          amount: String(BigInt(Math.round(amountNum))),
          limitPrice: String(BigInt(Math.round(priceNum))),
          expirySec,
          operatorNonce,
          matchNonce,
          ciphertext,
          replayKey,
        });

        setStatus("Submitting signed intent to relayer…");
        const result = await createInternalIntent(body);
        const order = {
          orderId: result?.orderId ?? "submitted",
          status: result?.status || "OPEN",
          matchIntentBound: !!result?.matchIntentBound,
          side,
          amount: amountNum,
          price: priceNum,
        };
        setLastOrder(order);
        setStatus("Submitted — encrypted, waiting for match.");
        return order;
      } catch (e) {
        const msg = e?.message || String(e);
        setError(msg);
        setStatus("");
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [config, isEnrolled, signer]
  );

  const cancelOrder = useCallback(
    async (orderId, reason = "user_cancel") => {
      setError("");
      if (!signer) {
        setError("Connect a wallet to cancel.");
        throw new Error("wallet_signer_required");
      }
      if (!config?.chainId || !config?.addresses?.shieldedPool) {
        setError("Relayer config missing chainId / shieldedPool.");
        throw new Error("relayer_config_missing");
      }
      setBusy(true);
      try {
        setStatus("Signing cancel…");
        const signed = await signCancel({
          signer,
          chainId: config.chainId,
          verifyingContract: config.addresses.shieldedPool,
          orderId,
          reason,
        });
        setStatus("Submitting cancel to relayer…");
        const out = await cancelInternalIntent(signed);
        setStatus("Order cancelled.");
        return out;
      } catch (e) {
        const msg = e?.message || String(e);
        setError(msg);
        setStatus("");
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [config, signer]
  );

  const getMatchStatus = useCallback(async (matchHash) => {
    if (!matchHash) return null;
    try {
      return await getInternalMatchStatus(matchHash);
    } catch (e) {
      const msg = e?.message || String(e);
      if (/404/.test(msg)) return null;
      throw e;
    }
  }, []);

  return {
    // state
    config,
    configError,
    fheAvailable,
    enrollment,
    enrollmentLoaded,
    isEnrolled,
    pendingNotes,
    withdrawPlan,
    status,
    error,
    busy,
    lastOrder,
    // actions
    submitInternalOrder,
    enroll,
    cancelOrder,
    refreshEnrollment,
    refreshPendingNotes,
    refreshWithdrawPlan,
    getMatchStatus,
    // copy helpers
    privacyCopy: {
      headline:
        "Encrypted off-chain order book — the matching server never reads your amounts or prices.",
      v1Disclaimer:
        "On-chain enrollment is visible; trade amounts only appear on-chain at withdraw (v1 — full on-chain amount privacy is a v2 ZK circuit upgrade).",
    },
  };
}

const express = require("express");
const { ethers } = require("ethers");
const { z } = require("zod");
const {
  saveInternalMatchEnrollment,
  getInternalMatchEnrollmentByUser,
} = require("./db");
const { decryptEnrollmentMetadata } = require("./enrollmentCipher");

const enrollSchema = z
  .object({
    userAddress: z.string().refine((v) => ethers.isAddress(v)),
    enrollmentId: z.string().refine((v) => ethers.isHexString(v, 32)),
    payloadHash: z.string().refine((v) => ethers.isHexString(v, 32)),
    txHash: z.string().refine((v) => ethers.isHexString(v, 32)),
    blockNumber: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).optional(),
    encryptedPayload: z.string().optional(),
  })
  .strict();

const ENROLL_EVENT_TOPIC = ethers.id(
  "InternalMatchEnrolled(address,bytes32,bytes32,bytes)"
);

function parseEnrollmentLog(receipt) {
  for (const log of receipt.logs || []) {
    if (log.topics?.[0] !== ENROLL_EVENT_TOPIC) continue;
    try {
      const user = ethers.getAddress(ethers.dataSlice(log.topics[1], 12));
      const enrollmentId = log.topics[2];
      const payloadHash = log.topics[3];
      return { user, enrollmentId, payloadHash };
    } catch {
      continue;
    }
  }
  return null;
}

function createInternalMatchEnrollmentRouter({ db, provider, poolAddress }) {
  const router = express.Router();

  router.post("/enroll", async (req, res) => {
    const parsed = enrollSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const userAddress = ethers.getAddress(parsed.data.userAddress).toLowerCase();
    const enrollmentId = ethers.hexlify(parsed.data.enrollmentId).toLowerCase();
    const payloadHash = ethers.hexlify(parsed.data.payloadHash).toLowerCase();
    const txHash = ethers.hexlify(parsed.data.txHash).toLowerCase();
    const blockNumber =
      parsed.data.blockNumber != null ? Number(parsed.data.blockNumber) : null;

    if (provider && poolAddress && ethers.isAddress(poolAddress)) {
      try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) {
          return res.status(400).json({ error: "enrollment_tx_not_confirmed", txHash });
        }
        const parsedLog = parseEnrollmentLog(receipt);
        if (!parsedLog) {
          return res.status(400).json({ error: "enrollment_event_not_found", txHash });
        }
        if (parsedLog.user.toLowerCase() !== userAddress) {
          return res.status(400).json({ error: "enrollment_user_mismatch" });
        }
        if (parsedLog.enrollmentId.toLowerCase() !== enrollmentId) {
          return res.status(400).json({ error: "enrollment_id_mismatch" });
        }
        if (parsedLog.payloadHash.toLowerCase() !== payloadHash) {
          return res.status(400).json({ error: "enrollment_payload_hash_mismatch" });
        }
      } catch (e) {
        return res.status(503).json({ error: "enrollment_tx_verify_failed", message: e.message });
      }
    }

    const existing = getInternalMatchEnrollmentByUser(db, userAddress);
    if (existing) {
      if (
        existing.enrollmentId === enrollmentId &&
        existing.txHash === txHash
      ) {
        return res.json({
          enrolled: true,
          userAddress,
          enrollmentId: existing.enrollmentId,
          idempotent: true,
        });
      }
      return res.status(409).json({ error: "user_already_enrolled", userAddress });
    }

    try {
      saveInternalMatchEnrollment(db, {
        userAddress,
        enrollmentId,
        payloadHash,
        encryptedPayload: parsed.data.encryptedPayload || null,
        txHash,
        blockNumber,
        createdAt: Date.now(),
      });
    } catch (e) {
      return res.status(409).json({ error: "enrollment_record_conflict", message: e.message });
    }

    return res.status(201).json({
      enrolled: true,
      userAddress,
      enrollmentId,
      payloadHash,
      txHash,
      idempotent: false,
    });
  });

  router.get("/enrollment/:address", (req, res) => {
    const raw = String(req.params.address || "").trim();
    if (!ethers.isAddress(raw)) {
      return res.status(400).json({ error: "invalid_address" });
    }
    const userAddress = ethers.getAddress(raw).toLowerCase();
    const row = getInternalMatchEnrollmentByUser(db, userAddress);
    if (!row) {
      return res.status(404).json({ error: "enrollment_not_found", userAddress });
    }
    let decryptedMetadata = null;
    if (row.encryptedPayload) {
      try {
        const hex = row.encryptedPayload.startsWith("0x")
          ? row.encryptedPayload.slice(2)
          : row.encryptedPayload;
        decryptedMetadata = decryptEnrollmentMetadata(Buffer.from(hex, "hex"));
      } catch {
        decryptedMetadata = null;
      }
    }
    return res.json({
      enrolled: true,
      userAddress: row.userAddress,
      enrollmentId: row.enrollmentId,
      payloadHash: row.payloadHash,
      txHash: row.txHash,
      blockNumber: row.blockNumber,
      createdAt: row.createdAt,
      decryptedMetadata,
    });
  });

  return router;
}

module.exports = {
  createInternalMatchEnrollmentRouter,
  ENROLL_EVENT_TOPIC,
  parseEnrollmentLog,
};

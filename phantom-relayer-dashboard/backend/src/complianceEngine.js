const crypto = require("crypto");
const {
  getInternalOrderById,
  saveComplianceDecision,
} = require("./db");

const COMPLIANCE_ACTION = Object.freeze({
  BLOCK_CANCEL: "BLOCK_CANCEL",
  HOLD_REVIEW: "HOLD_REVIEW",
  ESCALATE_MANUAL: "ESCALATE_MANUAL",
  ALLOW: "ALLOW",
});

const COMPLIANCE_PHASE = Object.freeze({
  INTAKE: "intake",
  EXECUTION: "execution",
});

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value || {})).digest("hex");
}

function normalizePolicy(opts = {}) {
  return {
    mode: String(opts.mode ?? process.env.COMPLIANCE_POLICY_MODE ?? "enforced"),
    version: String(opts.version ?? process.env.COMPLIANCE_POLICY_VERSION ?? "v1"),
  };
}

function makeDefaultScreeningProvider() {
  const blocked = new Set(splitCsv(process.env.COMPLIANCE_BLOCKLIST_ADDRESSES));
  const hold = new Set(splitCsv(process.env.COMPLIANCE_HOLD_ADDRESSES));
  const escalate = new Set(splitCsv(process.env.COMPLIANCE_ESCALATE_ADDRESSES));

  return async function defaultScreeningProvider({ actorRef }) {
    const key = String(actorRef || "").toLowerCase();
    if (!key) {
      return {
        reasonCode: "COMPLIANCE_NO_ACTOR",
        action: COMPLIANCE_ACTION.ESCALATE_MANUAL,
        evidenceRef: "local:missing_actor",
        providerResponse: { actorRef: null },
      };
    }
    if (blocked.has(key)) {
      return {
        reasonCode: "COMPLIANCE_BLOCKLIST_MATCH",
        action: COMPLIANCE_ACTION.BLOCK_CANCEL,
        evidenceRef: "local:blocklist",
        providerResponse: { actorRef: key },
      };
    }
    if (hold.has(key)) {
      return {
        reasonCode: "COMPLIANCE_HOLDLIST_MATCH",
        action: COMPLIANCE_ACTION.HOLD_REVIEW,
        evidenceRef: "local:holdlist",
        providerResponse: { actorRef: key },
      };
    }
    if (escalate.has(key)) {
      return {
        reasonCode: "COMPLIANCE_ESCALATE_MATCH",
        action: COMPLIANCE_ACTION.ESCALATE_MANUAL,
        evidenceRef: "local:escalate",
        providerResponse: { actorRef: key },
      };
    }
    return {
      reasonCode: "COMPLIANCE_ALLOW_DEFAULT",
      action: COMPLIANCE_ACTION.ALLOW,
      evidenceRef: "local:none",
      providerResponse: { actorRef: key },
    };
  };
}

function mapExecutionActionToReason(action) {
  if (action === COMPLIANCE_ACTION.BLOCK_CANCEL) return "COMPLIANCE_BLOCKED";
  if (action === COMPLIANCE_ACTION.HOLD_REVIEW) return "COMPLIANCE_HOLD";
  if (action === COMPLIANCE_ACTION.ESCALATE_MANUAL) return "COMPLIANCE_ESCALATED";
  return null;
}

function createComplianceEngine({ db, screeningProvider } = {}) {
  const provider = screeningProvider || makeDefaultScreeningProvider();

  async function evaluateAndPersist(input) {
    const out = await provider(input);
    const action = Object.values(COMPLIANCE_ACTION).includes(out?.action)
      ? out.action
      : COMPLIANCE_ACTION.ESCALATE_MANUAL;
    const reasonCode = String(out?.reasonCode || "COMPLIANCE_PROVIDER_UNSPECIFIED");
    const evidenceRef = out?.evidenceRef ? String(out.evidenceRef) : null;
    const providerResponseHash = hashJson(out?.providerResponse || {});
    const row = {
      id: crypto.randomUUID(),
      phase: input.phase,
      action,
      orderId: input.orderId || null,
      actorRef: input.actorRef || null,
      counterpartyRef: input.counterpartyRef || null,
      matchHash: input.matchHash || null,
      executionKey: input.executionKey || null,
      executionId: input.executionId || null,
      traceId: input.traceId,
      reasonCode,
      policyMode: input.policy.mode,
      policyVersion: input.policy.version,
      evidenceRef,
      providerResponseHash,
      detailsJson: {
        fheDecisionHash: input.fheDecisionHash || null,
        fheResultHash: input.fheResultHash || null,
        providerMeta: out?.providerMeta || null,
      },
      createdAt: Date.now(),
    };
    saveComplianceDecision(db, row);
    return row;
  }

  async function checkIntake({ traceId, orderId, ownerAddress, counterpartyRef = null, policy = {} }) {
    const pol = normalizePolicy(policy);
    const decision = await evaluateAndPersist({
      phase: COMPLIANCE_PHASE.INTAKE,
      traceId,
      orderId,
      actorRef: ownerAddress ? String(ownerAddress).toLowerCase() : null,
      counterpartyRef,
      policy: pol,
    });
    return {
      allowed: decision.action === COMPLIANCE_ACTION.ALLOW,
      action: decision.action,
      reasonCode: decision.reasonCode,
      decision,
    };
  }

  async function checkExecution({ traceId, executionId = null, match, policy = {} }) {
    const pol = normalizePolicy(policy);
    const takerOrder = getInternalOrderById(db, match.takerOrderId);
    const makerOrder = getInternalOrderById(db, match.makerOrderId);
    const items = [
      {
        role: "taker",
        order: takerOrder,
        ownOrderId: match.takerOrderId,
        cpOrderId: match.makerOrderId,
      },
      {
        role: "maker",
        order: makerOrder,
        ownOrderId: match.makerOrderId,
        cpOrderId: match.takerOrderId,
      },
    ];
    const decisions = [];
    for (const it of items) {
      const actorRef = it.order?.ownerAddress
        ? String(it.order.ownerAddress).toLowerCase()
        : `order:${it.ownOrderId}`;
      const row = await evaluateAndPersist({
        phase: COMPLIANCE_PHASE.EXECUTION,
        traceId,
        orderId: it.ownOrderId,
        actorRef,
        counterpartyRef: it.cpOrderId,
        matchHash: match.matchHash,
        executionKey: match.executionKey,
        executionId,
        policy: pol,
        fheDecisionHash: match.fheDecisionHash || null,
        fheResultHash: match.fheResultHash || null,
      });
      decisions.push(row);
    }
    const worst =
      decisions.find((d) => d.action === COMPLIANCE_ACTION.BLOCK_CANCEL) ||
      decisions.find((d) => d.action === COMPLIANCE_ACTION.HOLD_REVIEW) ||
      decisions.find((d) => d.action === COMPLIANCE_ACTION.ESCALATE_MANUAL) ||
      decisions[0];
    return {
      allowed: decisions.every((d) => d.action === COMPLIANCE_ACTION.ALLOW),
      action: worst.action,
      reasonCode: mapExecutionActionToReason(worst.action),
      decisions,
      drift: decisions.some((d) => d.phase === COMPLIANCE_PHASE.EXECUTION && d.action !== COMPLIANCE_ACTION.ALLOW),
    };
  }

  return {
    COMPLIANCE_ACTION,
    COMPLIANCE_PHASE,
    normalizePolicy,
    mapExecutionActionToReason,
    checkIntake,
    checkExecution,
  };
}

module.exports = {
  createComplianceEngine,
  COMPLIANCE_ACTION,
  COMPLIANCE_PHASE,
};

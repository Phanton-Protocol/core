const ORDER_STATUS = Object.freeze({
  OPEN: "open",
  RESERVED: "reserved",
  PARTIALLY_FILLED: "partially_filled",
  FILLED: "filled",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  FAILED: "failed",
});

const LEGAL_TRANSITIONS = Object.freeze({
  [ORDER_STATUS.OPEN]: new Set([
    ORDER_STATUS.RESERVED,
    ORDER_STATUS.PARTIALLY_FILLED,
    ORDER_STATUS.FILLED,
    ORDER_STATUS.CANCELLED,
    ORDER_STATUS.EXPIRED,
    ORDER_STATUS.FAILED,
  ]),
  [ORDER_STATUS.RESERVED]: new Set([
    ORDER_STATUS.OPEN,
    ORDER_STATUS.PARTIALLY_FILLED,
    ORDER_STATUS.FILLED,
    ORDER_STATUS.CANCELLED,
    ORDER_STATUS.EXPIRED,
    ORDER_STATUS.FAILED,
  ]),
  [ORDER_STATUS.PARTIALLY_FILLED]: new Set([
    ORDER_STATUS.RESERVED,
    ORDER_STATUS.FILLED,
    ORDER_STATUS.CANCELLED,
    ORDER_STATUS.EXPIRED,
    ORDER_STATUS.FAILED,
  ]),
  [ORDER_STATUS.FILLED]: new Set([]),
  [ORDER_STATUS.CANCELLED]: new Set([]),
  [ORDER_STATUS.EXPIRED]: new Set([]),
  [ORDER_STATUS.FAILED]: new Set([]),
});

function isLegalTransition(fromStatus, toStatus) {
  if (!LEGAL_TRANSITIONS[fromStatus]) return false;
  return LEGAL_TRANSITIONS[fromStatus].has(toStatus);
}

function assertLegalTransition(fromStatus, toStatus) {
  if (!isLegalTransition(fromStatus, toStatus)) {
    const err = new Error(`illegal_order_transition:${fromStatus}->${toStatus}`);
    err.status = 409;
    throw err;
  }
}

function canCancel(status) {
  return status === ORDER_STATUS.OPEN || status === ORDER_STATUS.RESERVED || status === ORDER_STATUS.PARTIALLY_FILLED;
}

module.exports = {
  ORDER_STATUS,
  LEGAL_TRANSITIONS,
  isLegalTransition,
  assertLegalTransition,
  canCancel,
};

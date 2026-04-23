const test = require("node:test");
const assert = require("node:assert/strict");
const { ORDER_STATUS, isLegalTransition, assertLegalTransition, canCancel } = require("../src/internalOrderLifecycle");

test("module1 FSM allows expected transitions", () => {
  assert.equal(isLegalTransition(ORDER_STATUS.OPEN, ORDER_STATUS.CANCELLED), true);
  assert.equal(isLegalTransition(ORDER_STATUS.OPEN, ORDER_STATUS.RESERVED), true);
  assert.equal(isLegalTransition(ORDER_STATUS.RESERVED, ORDER_STATUS.PARTIALLY_FILLED), true);
  assert.equal(isLegalTransition(ORDER_STATUS.PARTIALLY_FILLED, ORDER_STATUS.FILLED), true);
});

test("module1 FSM rejects illegal terminal transitions", () => {
  assert.equal(isLegalTransition(ORDER_STATUS.CANCELLED, ORDER_STATUS.OPEN), false);
  assert.equal(isLegalTransition(ORDER_STATUS.FILLED, ORDER_STATUS.CANCELLED), false);
  assert.throws(() => assertLegalTransition(ORDER_STATUS.EXPIRED, ORDER_STATUS.OPEN), /illegal_order_transition/);
});

test("module1 cancellable states are enforced", () => {
  assert.equal(canCancel(ORDER_STATUS.OPEN), true);
  assert.equal(canCancel(ORDER_STATUS.RESERVED), true);
  assert.equal(canCancel(ORDER_STATUS.PARTIALLY_FILLED), true);
  assert.equal(canCancel(ORDER_STATUS.FILLED), false);
  assert.equal(canCancel(ORDER_STATUS.CANCELLED), false);
});

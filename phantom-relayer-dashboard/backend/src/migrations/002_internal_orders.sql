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
  filledAmount TEXT NOT NULL DEFAULT '0',
  reservedAmount TEXT NOT NULL DEFAULT '0',
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

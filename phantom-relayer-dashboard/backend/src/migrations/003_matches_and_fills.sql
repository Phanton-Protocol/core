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

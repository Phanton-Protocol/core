CREATE TABLE IF NOT EXISTS settlement_executions (
  executionId TEXT PRIMARY KEY,
  matchHash TEXT NOT NULL UNIQUE,
  executionKey TEXT NOT NULL,
  status TEXT NOT NULL,
  attemptCount INTEGER NOT NULL,
  txHash TEXT,
  traceId TEXT NOT NULL,
  fallbackMode TEXT,
  fallbackReasonCode TEXT,
  errorCode TEXT,
  errorMessage TEXT,
  payloadJson TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  lastAttemptAt INTEGER
);

CREATE INDEX IF NOT EXISTS idx_settlement_exec_status_updated ON settlement_executions(status, updatedAt DESC);

CREATE TABLE IF NOT EXISTS settlement_events (
  id TEXT PRIMARY KEY,
  executionId TEXT NOT NULL,
  matchHash TEXT NOT NULL,
  traceId TEXT NOT NULL,
  eventType TEXT NOT NULL,
  reasonCode TEXT,
  detailsJson TEXT,
  createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_settlement_events_execution_created ON settlement_events(executionId, createdAt);
CREATE INDEX IF NOT EXISTS idx_settlement_events_match_created ON settlement_events(matchHash, createdAt);

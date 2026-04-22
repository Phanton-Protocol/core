CREATE TABLE IF NOT EXISTS compliance_decisions (
  id TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  action TEXT NOT NULL,
  orderId TEXT,
  actorRef TEXT,
  counterpartyRef TEXT,
  matchHash TEXT,
  executionKey TEXT,
  executionId TEXT,
  traceId TEXT NOT NULL,
  reasonCode TEXT NOT NULL,
  policyMode TEXT NOT NULL,
  policyVersion TEXT NOT NULL,
  evidenceRef TEXT,
  providerResponseHash TEXT,
  detailsJson TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_order_created ON compliance_decisions(orderId, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_match_created ON compliance_decisions(matchHash, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_execution_created ON compliance_decisions(executionId, createdAt DESC);

CREATE TABLE IF NOT EXISTS attestation_decisions (
  id TEXT PRIMARY KEY,
  matchHash TEXT NOT NULL,
  executionKey TEXT NOT NULL,
  executionId TEXT,
  traceId TEXT NOT NULL,
  policyVersion TEXT NOT NULL,
  requiredQuorumBps INTEGER NOT NULL,
  valid INTEGER NOT NULL,
  reasonCode TEXT,
  signerCount INTEGER NOT NULL,
  signerSetHash TEXT,
  detailsJson TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attestation_decisions_match_created ON attestation_decisions(matchHash, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_attestation_decisions_execution_created ON attestation_decisions(executionId, createdAt DESC);

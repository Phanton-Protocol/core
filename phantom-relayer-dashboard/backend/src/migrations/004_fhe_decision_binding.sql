ALTER TABLE matches ADD COLUMN decisionReasonCode TEXT;
ALTER TABLE matches ADD COLUMN fheResultHash TEXT;
ALTER TABLE matches ADD COLUMN fheDecisionHash TEXT;
ALTER TABLE matches ADD COLUMN fheAttestationRef TEXT;

CREATE TABLE IF NOT EXISTS match_decisions (
  id TEXT PRIMARY KEY,
  traceId TEXT NOT NULL,
  takerOrderId TEXT NOT NULL,
  candidateOrderId TEXT,
  matchHash TEXT,
  executionKey TEXT,
  reasonCode TEXT NOT NULL,
  policyMode TEXT NOT NULL,
  fheDecisionHash TEXT,
  fheResultHash TEXT,
  fheAttestationRef TEXT,
  detailsJson TEXT,
  createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_match_decisions_taker_created ON match_decisions(takerOrderId, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_match_decisions_candidate_created ON match_decisions(candidateOrderId, createdAt DESC);

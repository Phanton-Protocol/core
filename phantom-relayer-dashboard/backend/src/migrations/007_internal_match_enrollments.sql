CREATE TABLE IF NOT EXISTS internal_match_enrollments (
  userAddress TEXT PRIMARY KEY,
  enrollmentId TEXT NOT NULL UNIQUE,
  payloadHash TEXT NOT NULL,
  encryptedPayload TEXT,
  txHash TEXT NOT NULL,
  blockNumber INTEGER,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_internal_match_enrollments_created ON internal_match_enrollments(createdAt DESC);

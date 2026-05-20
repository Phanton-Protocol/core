CREATE TABLE IF NOT EXISTS internal_match_audit_log (
  id TEXT PRIMARY KEY,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  match_hash TEXT NOT NULL,
  decision_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_internal_match_audit_match ON internal_match_audit_log(match_hash);
CREATE INDEX IF NOT EXISTS idx_internal_match_audit_created ON internal_match_audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS pending_notes (
  note_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  match_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_enc TEXT NOT NULL,
  input_note_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_notes_owner_status ON pending_notes(owner, status);
CREATE INDEX IF NOT EXISTS idx_pending_notes_match ON pending_notes(match_hash);

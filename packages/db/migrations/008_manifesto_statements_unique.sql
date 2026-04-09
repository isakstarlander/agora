-- Migration 008: Add unique constraint on manifesto_statements (manifesto_id, statement_index)
-- Required for idempotent upserts in the manifesto ingestion script.
ALTER TABLE manifesto_statements
  ADD CONSTRAINT uq_manifesto_statements_idx UNIQUE (manifesto_id, statement_index);

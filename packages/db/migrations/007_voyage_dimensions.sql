-- Migration 007: Change embedding columns from vector(1536) to vector(1024)
-- to match Voyage AI voyage-4 series output dimensions.
-- Must be applied before any embeddings are stored.

-- Drop HNSW indexes first (required before altering column type)
DROP INDEX IF EXISTS idx_manifesto_statements_embedding;
DROP INDEX IF EXISTS idx_document_chunks_embedding;

-- Alter embedding columns to 1024 dimensions
ALTER TABLE manifesto_statements
  ALTER COLUMN embedding TYPE vector(1024)
  USING NULL; -- existing embeddings (if any) are incompatible; discard them

ALTER TABLE document_chunks
  ALTER COLUMN embedding TYPE vector(1024)
  USING NULL;

-- Recreate HNSW indexes with correct dimensions
CREATE INDEX idx_manifesto_statements_embedding
  ON manifesto_statements USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_document_chunks_embedding
  ON document_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

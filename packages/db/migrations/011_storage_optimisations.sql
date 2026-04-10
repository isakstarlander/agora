-- 011_storage_optimisations.sql
-- Apply in order. Requires no data backfill — embeddings are regenerated post-migration.

-- 1. Drop body_html from document_texts.
--    body_text is sufficient for FTS and API responses.
--    The raw HTML is re-fetchable from documents.document_url if ever needed.
ALTER TABLE document_texts DROP COLUMN IF EXISTS body_html;

-- 2. Drop existing HNSW vector indexes before column type changes.
--    pgvector requires the index to be dropped before altering vector dimensions.
DROP INDEX IF EXISTS idx_document_chunks_embedding;
DROP INDEX IF EXISTS idx_manifesto_statements_embedding;

-- 3. Null out existing embeddings.
--    Even though voyage-4-lite supports Matryoshka truncation, we clear existing
--    embeddings to guarantee a clean regeneration pass at exactly 512 dims.
UPDATE document_chunks         SET embedding = NULL;
UPDATE manifesto_statements    SET embedding = NULL;

-- 4. Resize embedding columns to 512 dimensions.
ALTER TABLE document_chunks
  ALTER COLUMN embedding TYPE vector(512);

ALTER TABLE manifesto_statements
  ALTER COLUMN embedding TYPE vector(512);

-- 5. Recreate HNSW indexes at the new dimension.
CREATE INDEX idx_document_chunks_embedding
  ON document_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_manifesto_statements_embedding
  ON manifesto_statements USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 6. Update the search_documents hybrid search function to accept vector(512).
--    Drop and recreate — ALTER FUNCTION cannot change parameter types.
DROP FUNCTION IF EXISTS search_documents(text, vector, text, text, int);

CREATE OR REPLACE FUNCTION search_documents(
  query_text      text,
  query_embedding vector(512),
  doc_type        text    DEFAULT NULL,
  doc_rm          text    DEFAULT NULL,
  match_count     int     DEFAULT 10
)
RETURNS TABLE (
  id          text,
  title       text,
  type        text,
  rm          text,
  date        date,
  source_url  text,
  fts_rank    real,
  vec_rank    real
)
LANGUAGE sql STABLE AS $$
  WITH fts AS (
    SELECT
      d.id,
      ts_rank_cd(
        to_tsvector('swedish', coalesce(dt.body_text, '')),
        plainto_tsquery('swedish', query_text)
      ) AS rank
    FROM documents d
    JOIN document_texts dt ON dt.document_id = d.id
    WHERE
      to_tsvector('swedish', coalesce(dt.body_text, ''))
        @@ plainto_tsquery('swedish', query_text)
      AND (doc_type IS NULL OR d.type = doc_type)
      AND (doc_rm   IS NULL OR d.rm   = doc_rm)
  ),
  vec AS (
    SELECT
      dc.document_id AS id,
      1 - (dc.embedding <=> query_embedding) AS similarity
    FROM document_chunks dc
    JOIN documents d ON d.id = dc.document_id
    WHERE
      (doc_type IS NULL OR d.type = doc_type)
      AND (doc_rm IS NULL OR d.rm = doc_rm)
    ORDER BY dc.embedding <=> query_embedding
    LIMIT match_count * 5
  ),
  combined AS (
    SELECT
      coalesce(fts.id, vec.id)                        AS id,
      coalesce(fts.rank, 0)  * 0.4
        + coalesce(vec.similarity, 0) * 0.6           AS score,
      coalesce(fts.rank, 0)                           AS fts_rank,
      coalesce(vec.similarity, 0)                     AS vec_rank
    FROM fts
    FULL OUTER JOIN vec ON fts.id = vec.id
  )
  SELECT
    d.id, d.title, d.type, d.rm, d.date, d.source_url,
    c.fts_rank::real, c.vec_rank::real
  FROM combined c
  JOIN documents d ON d.id = c.id
  ORDER BY c.score DESC
  LIMIT match_count;
$$;

-- 7. Update match_manifesto_statements to accept vector(512).
--    Supersedes the version created in migration 010_manifesto_search.sql.
DROP FUNCTION IF EXISTS match_manifesto_statements(vector, int);

CREATE OR REPLACE FUNCTION match_manifesto_statements(
  query_embedding vector(512),
  match_count     int DEFAULT 10
)
RETURNS TABLE (
  id              int,
  manifesto_id    int,
  text            text,
  category_code   text,
  category_name   text,
  "position"      smallint,
  statement_index int,
  similarity      real
)
LANGUAGE sql STABLE AS $$
  SELECT
    ms.id,
    ms.manifesto_id,
    ms.text,
    ms.category_code,
    ms.category_name,
    ms.position AS "position",
    ms.statement_index,
    (1 - (ms.embedding <=> query_embedding))::real AS similarity
  FROM manifesto_statements ms
  WHERE ms.embedding IS NOT NULL
  ORDER BY ms.embedding <=> query_embedding
  LIMIT match_count;
$$;

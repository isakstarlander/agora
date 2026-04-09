-- Hybrid search: combine full-text + vector similarity
CREATE OR REPLACE FUNCTION search_documents(
  query_text      TEXT,
  query_embedding vector(1536),
  doc_type        TEXT DEFAULT NULL,
  doc_rm          TEXT DEFAULT NULL,
  match_count     INT DEFAULT 10
)
RETURNS TABLE (
  id          TEXT,
  title       TEXT,
  type        TEXT,
  rm          TEXT,
  date        DATE,
  source_url  TEXT,
  fts_rank    REAL,
  vec_rank    REAL
)
LANGUAGE sql STABLE AS $$
  WITH fts AS (
    SELECT d.id,
           ts_rank(to_tsvector('swedish', d.title || ' ' || COALESCE(dt.body_text, '')),
                   plainto_tsquery('swedish', query_text)) AS rank
    FROM documents d
    LEFT JOIN document_texts dt ON dt.document_id = d.id
    WHERE to_tsvector('swedish', d.title || ' ' || COALESCE(dt.body_text, ''))
            @@ plainto_tsquery('swedish', query_text)
      AND (doc_type IS NULL OR d.type = doc_type)
      AND (doc_rm IS NULL OR d.rm = doc_rm)
    ORDER BY rank DESC
    LIMIT match_count * 2
  ),
  vec AS (
    SELECT dc.document_id AS id,
           1 - (dc.embedding <=> query_embedding) AS similarity
    FROM document_chunks dc
    JOIN documents d ON d.id = dc.document_id
    WHERE (doc_type IS NULL OR d.type = doc_type)
      AND (doc_rm IS NULL OR d.rm = doc_rm)
    ORDER BY dc.embedding <=> query_embedding
    LIMIT match_count * 2
  )
  SELECT
    d.id, d.title, d.type, d.rm, d.date, d.source_url,
    COALESCE(fts.rank, 0)        AS fts_rank,
    COALESCE(vec.similarity, 0)  AS vec_rank
  FROM documents d
  LEFT JOIN fts ON fts.id = d.id
  LEFT JOIN vec ON vec.id = d.id
  WHERE fts.id IS NOT NULL OR vec.id IS NOT NULL
  ORDER BY (COALESCE(fts.rank, 0) * 0.4 + COALESCE(vec.similarity, 0) * 0.6) DESC
  LIMIT match_count;
$$;

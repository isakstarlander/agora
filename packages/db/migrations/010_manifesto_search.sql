CREATE OR REPLACE FUNCTION match_manifesto_statements(
  query_embedding vector(1024),
  match_count     INT DEFAULT 10
)
RETURNS TABLE (
  id               INT,
  manifesto_id     INT,
  text             TEXT,
  category_code    TEXT,
  category_name    TEXT,
  "position"       SMALLINT,
  statement_index  INT,
  similarity       REAL
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
    1 - (ms.embedding <=> query_embedding) AS similarity
  FROM manifesto_statements ms
  WHERE ms.embedding IS NOT NULL
  ORDER BY ms.embedding <=> query_embedding
  LIMIT match_count;
$$;

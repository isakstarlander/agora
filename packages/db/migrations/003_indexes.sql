-- Full-text search (Swedish dictionary)
CREATE INDEX idx_documents_title_fts
  ON documents USING GIN (to_tsvector('swedish', title));

CREATE INDEX idx_document_texts_body_fts
  ON document_texts USING GIN (to_tsvector('swedish', body_text));

-- Trigram index for ILIKE / fuzzy name search
CREATE INDEX idx_members_name_trgm
  ON members USING GIN ((first_name || ' ' || last_name) gin_trgm_ops);

-- Filtering indexes
CREATE INDEX idx_documents_type_rm   ON documents (type, rm);
CREATE INDEX idx_documents_date      ON documents (date DESC);
CREATE INDEX idx_documents_committee ON documents (committee);
CREATE INDEX idx_members_party       ON members (party);
CREATE INDEX idx_members_status      ON members (status);
CREATE INDEX idx_vote_results_party  ON vote_results (party);
CREATE INDEX idx_votes_date          ON votes (date DESC);
CREATE INDEX idx_votes_rm            ON votes (rm);
CREATE INDEX idx_speeches_member     ON speeches (member_id);
CREATE INDEX idx_speeches_date       ON speeches (date DESC);
CREATE INDEX idx_budget_year         ON budget_outcomes (year, expenditure_area_code);

-- Vector (HNSW for fast approximate nearest-neighbour)
CREATE INDEX idx_manifesto_statements_embedding
  ON manifesto_statements USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_document_chunks_embedding
  ON document_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

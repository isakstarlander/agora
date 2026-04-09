-- All tables are publicly readable (v1 has no auth)
-- Write access is ONLY via secret key (ingestion scripts + server API routes)

ALTER TABLE members              ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents            ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_texts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_authors     ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes                ENABLE ROW LEVEL SECURITY;
ALTER TABLE vote_results         ENABLE ROW LEVEL SECURITY;
ALTER TABLE speeches             ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_outcomes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE manifestos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE manifesto_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_runs       ENABLE ROW LEVEL SECURITY;

-- Public read on all data tables
CREATE POLICY "public_read_members"
  ON members FOR SELECT USING (true);
CREATE POLICY "public_read_documents"
  ON documents FOR SELECT USING (true);
CREATE POLICY "public_read_document_texts"
  ON document_texts FOR SELECT USING (true);
CREATE POLICY "public_read_document_authors"
  ON document_authors FOR SELECT USING (true);
CREATE POLICY "public_read_votes"
  ON votes FOR SELECT USING (true);
CREATE POLICY "public_read_vote_results"
  ON vote_results FOR SELECT USING (true);
CREATE POLICY "public_read_speeches"
  ON speeches FOR SELECT USING (true);
CREATE POLICY "public_read_budget_outcomes"
  ON budget_outcomes FOR SELECT USING (true);
CREATE POLICY "public_read_manifestos"
  ON manifestos FOR SELECT USING (true);
CREATE POLICY "public_read_manifesto_statements"
  ON manifesto_statements FOR SELECT USING (true);
CREATE POLICY "public_read_document_chunks"
  ON document_chunks FOR SELECT USING (true);
-- ingestion_runs: no public read (internal only)

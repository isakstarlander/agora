-- ── Members / Ledamöter ───────────────────────────────────────────────────
CREATE TABLE members (
  id            TEXT PRIMARY KEY,              -- Riksdagen person ID (13 chars)
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  party         TEXT NOT NULL,                 -- S | M | SD | C | V | KD | L | MP | …
  constituency  TEXT,                          -- valkrets
  status        TEXT NOT NULL DEFAULT 'active', -- active | inactive
  birth_year    INT,
  gender        TEXT,                          -- man | kvinna | okänt
  image_url     TEXT,
  from_date     DATE,
  to_date       DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Parliamentary Documents ───────────────────────────────────────────────
CREATE TABLE documents (
  id            TEXT PRIMARY KEY,              -- Riksdagen document ID
  type          TEXT NOT NULL,                 -- mot | prop | bet | ip | fr | prot | SFS
  rm            TEXT NOT NULL,                 -- riksmöte e.g. "2024/25"
  number        TEXT,                          -- document number within rm
  title         TEXT NOT NULL,
  subtitle      TEXT,
  status        TEXT,
  date          DATE,
  committee     TEXT,                          -- utskott code e.g. "FiU"
  source_url    TEXT,                          -- riksdagen.se page URL
  document_url  TEXT,                          -- direct link to HTML/PDF content
  ingested_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Document Full Text (separate table for performance) ───────────────────
CREATE TABLE document_texts (
  document_id   TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  body_html     TEXT,
  body_text     TEXT,                          -- stripped plain text
  word_count    INT,
  language      TEXT NOT NULL DEFAULT 'sv'
);

-- ── Document Authors (motioner can have multiple authors) ─────────────────
CREATE TABLE document_authors (
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, member_id)
);

-- ── Votes / Voteringar ────────────────────────────────────────────────────
CREATE TABLE votes (
  id            TEXT PRIMARY KEY,              -- votering ID from Riksdagen
  document_id   TEXT REFERENCES documents(id) ON DELETE SET NULL,
  rm            TEXT NOT NULL,
  date          DATE,
  description   TEXT,
  yes_count     INT NOT NULL DEFAULT 0,
  no_count      INT NOT NULL DEFAULT 0,
  abstain_count INT NOT NULL DEFAULT 0,
  absent_count  INT NOT NULL DEFAULT 0,
  outcome       TEXT,                          -- Bifall | Avslag
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Individual Vote Results ───────────────────────────────────────────────
CREATE TABLE vote_results (
  vote_id       TEXT NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  party         TEXT NOT NULL,
  result        TEXT NOT NULL,                 -- Ja | Nej | Frånvarande | Avstår
  PRIMARY KEY (vote_id, member_id)
);

-- ── Speeches / Anföranden ─────────────────────────────────────────────────
CREATE TABLE speeches (
  id                  TEXT PRIMARY KEY,
  member_id           TEXT REFERENCES members(id) ON DELETE SET NULL,
  document_id         TEXT REFERENCES documents(id) ON DELETE SET NULL,
  rm                  TEXT NOT NULL,
  date                DATE,
  anforande_nummer    INT,
  body_text           TEXT,
  word_count          INT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Budget Outcomes (ESV data) ────────────────────────────────────────────
CREATE TABLE budget_outcomes (
  id                      BIGSERIAL PRIMARY KEY,
  year                    INT NOT NULL,
  month                   INT,                 -- NULL = annual total
  expenditure_area_code   TEXT NOT NULL,       -- utgiftsområde number e.g. "01"
  expenditure_area_name   TEXT,
  anslag_code             TEXT,                -- e.g. "1:1"
  anslag_name             TEXT,
  agency                  TEXT,
  amount_sek              NUMERIC(20, 2),      -- in SEK (may be negative = inkomst)
  budget_type             TEXT NOT NULL,       -- utfall | budget
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year, month, anslag_code, budget_type)
);

-- ── Manifestos ────────────────────────────────────────────────────────────
CREATE TABLE manifestos (
  id            SERIAL PRIMARY KEY,
  party_code    TEXT NOT NULL,                 -- S | M | SD | C | V | KD | L | MP
  party_name    TEXT NOT NULL,
  election_year INT NOT NULL,
  source_url    TEXT,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (party_code, election_year)
);

-- ── Manifesto Statements (sentence-level, with embeddings) ───────────────
CREATE TABLE manifesto_statements (
  id              SERIAL PRIMARY KEY,
  manifesto_id    INT NOT NULL REFERENCES manifestos(id) ON DELETE CASCADE,
  text            TEXT NOT NULL,
  category_code   TEXT,                        -- Manifesto Project category
  category_name   TEXT,
  position        SMALLINT,                    -- -1 negative | 0 neutral | 1 positive
  statement_index INT,                         -- order within manifesto
  embedding       vector(1536),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Document Chunks (chunked docs with embeddings for RAG) ────────────────
CREATE TABLE document_chunks (
  id            SERIAL PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index   INT NOT NULL,
  text          TEXT NOT NULL,
  embedding     vector(1536),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

-- ── Ingestion Audit Log ───────────────────────────────────────────────────
CREATE TABLE ingestion_runs (
  id                  SERIAL PRIMARY KEY,
  source              TEXT NOT NULL,           -- riksdagen | esv | manifesto
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  records_processed   INT NOT NULL DEFAULT 0,
  records_inserted    INT NOT NULL DEFAULT 0,
  records_updated     INT NOT NULL DEFAULT 0,
  errors              JSONB,
  status              TEXT NOT NULL DEFAULT 'running'  -- running | success | failed
);

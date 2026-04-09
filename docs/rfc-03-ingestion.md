# RFC-03 — Data Ingestion Pipelines

| Field  | Value |
|--------|-------|
| Status | Implemented |
| Date   | 2026-04-09 |
| Author | GitHub Copilot |
| Spec   | `api-first/03-ingestion.md` + `3-ingestion-riksdagen.md` + `4-ingestion-budgets-manifestos.md` |

---

## Summary

Implemented all four data ingestion pipelines (Riksdagen, ESV, Manifesto Project, embeddings),
four GitHub Actions workflows, and one schema migration. All ingestion scripts typecheck
cleanly. The scripts workspace is fully operational: `npm run ingest:riksdagen`,
`ingest:esv`, `ingest:manifesto`, and `embed` all resolve correctly.

---

## Motivation

The API endpoints introduced from product request 05 onwards depend on populated data.
Members, documents, votes, budget outcomes, manifesto statements, and vector embeddings
must all be present in Supabase before any meaningful query can be served. This RFC
documents the pipeline that fills the database from four upstream sources.

---

## Decisions

### Embedding provider: Voyage AI instead of OpenAI

The `api-first/03-ingestion.md` spec suggested OpenAI `text-embedding-3-small` (1536 dims)
as a fallback if Anthropic embeddings were unavailable. Voyage AI (`voyage-4-lite`) was
selected instead for the following reasons:

- **No OpenAI dependency** — Voyage AI is owned by Anthropic, keeping the provider
  landscape consistent with the rest of the project.
- **200M free tokens per account** — the entire corpus (manifesto statements + document
  chunks) will fit within the free tier many times over.
- **After-free price parity** — `voyage-4-lite` costs $0.02/1M tokens, identical to
  `text-embedding-3-small`.
- **Cross-model compatibility** — all voyage-4 series models (`voyage-4-lite`, `voyage-4`,
  `voyage-4-large`) produce compatible embeddings. Upgrading quality requires only a
  model name change; no re-embedding is needed.
- **Current generation** — `voyage-3` and `voyage-3-lite` (mentioned in the spec) are
  now the previous generation. `voyage-4-lite` supersedes them with better quality at
  the same price.

### Embedding dimension: 1024 (migration 007)

The schema from RFC-02 declared `vector(1536)` to match `text-embedding-3-small`.
Voyage AI voyage-4 series outputs 1024 dimensions by default. Migration 007 alters
both embedding columns to `vector(1024)` and rebuilds the HNSW indexes.

`output_dimension: 1024` is pinned *explicitly* in every `voyage.embed()` call — not
left to the model's default. A single `EMBEDDING_DIM = 1024` constant in the embed
script is the source of truth. Any attempt to change it will require updating both the
constant and the migration, making dimension drift visible.

### Members: null-id records filtered out

The Riksdagen API includes historical records (pre-digital era members) that have no
person ID. Inserting these would violate the `members.id NOT NULL` primary key
constraint. These records are filtered out and logged before the upsert batch runs.

### `dotenv` loads `.env.local`, not `.env`

`dotenv/config` only reads `.env` by default. `.env.local` is a Next.js convention
that dotenv does not know about. `utils.ts` explicitly resolves `.env.local` from the
monorepo root using `fileURLToPath` + `path.resolve`. In GitHub Actions the file is
absent and dotenv silently no-ops; secrets injected via `env:` blocks in the workflow
are already in `process.env` and are unaffected.

### `skipLibCheck: true` added to `scripts/tsconfig.json`

`@supabase/realtime-js` references types from `@supabase/phoenix` which are not shipped
as a package. This caused three spurious TS2307 errors in transitive dependencies, not
in any code this project owns. `skipLibCheck: true` is already present in
`apps/web/tsconfig.json`; it was added to `scripts/tsconfig.json` for consistency.

### Riksdagen document authors: `undertecknare` role only

The Riksdagen API returns `intressenter` (stakeholders) for each document, each with a
`roll` (role) field. Only intressenter with `roll === 'undertecknare'` are treated as
authors and inserted into `document_authors`. Other roles (e.g. referral recipients)
are ignored to keep the author relationship semantically accurate.

### ESV extraction with `unzipper`

The Node.js standard library does not include ZIP extraction. `unzipper` (MIT license)
was added as a dependency. It streams the downloaded ZIP directly into an extraction
pipeline without buffering the entire archive, keeping memory usage low.

### Manifesto refresh strategy: upsert + prune

Manifesto statements are upserted by `(manifesto_id, statement_index)` on each ingestion
run, then any stale rows beyond the new statement count are pruned. This requires a
`UNIQUE (manifesto_id, statement_index)` constraint, added in migration 008.

This is safer than the original delete→insert design documented in the spec, which left
a window where statements were absent between the delete and the final insert batch.
The upsert+prune approach means data is always present and embeddings on unchanged rows
are preserved across re-runs.

### `position` field normalisation

The Manifesto Project API returns a `pos` field as a continuous float (e.g. 0.3, −1.2).
The schema stores `position` as `SMALLINT` with the convention `−1 | 0 | 1`. The script
maps: `pos > 0 → 1`, `pos < 0 → −1`, `pos === 0 or null → 0`.

### Riksmöte scope

The daily Riksdagen ingestion covers the **two most recent riksmöten** (current +
previous). This keeps daily runs under 60 minutes. Historical backfill (e.g. 2015/16
onwards) is a manual, one-off operation: temporarily modify `getRiksmotenToIngest()`,
run `workflow_dispatch`, then revert.

---

## Files Created / Changed

| File | Change |
|---|---|
| `scripts/ingest/utils.ts` | Created — Supabase factory, `startIngestionRun`, `finishIngestionRun`, `sleep`, `fetchRiksdagen`; loads `.env.local` explicitly |
| `scripts/ingest/members.ts` | Created — full member list refresh; filters records with no id |
| `scripts/ingest/documents.ts` | Created — 5 doc types, paginated, with authors |
| `scripts/ingest/voting.ts` | Created — vote lists + per-vote individual results |
| `scripts/ingest/riksdagen.ts` | Replaced placeholder — orchestrator |
| `scripts/ingest/esv.ts` | Replaced placeholder — ZIP download, CSV parse, budget upsert |
| `scripts/ingest/manifesto.ts` | Replaced placeholder — Manifesto Project API, 8 parties × 4 years; upsert+prune strategy |
| `scripts/embed/generate-embeddings.ts` | Replaced placeholder — Voyage AI, `EMBEDDING_DIM = 1024` |
| `packages/db/migrations/007_voyage_dimensions.sql` | Created — vector columns 1536 → 1024, HNSW rebuild |
| `packages/db/migrations/008_manifesto_statements_unique.sql` | Created — `UNIQUE (manifesto_id, statement_index)` constraint |
| `scripts/package.json` | Added `unzipper`, `@types/unzipper`, `voyageai` |
| `scripts/tsconfig.json` | Added `skipLibCheck: true` |
| `.env.example` | Added `VOYAGE_API_KEY=` |
| `.github/workflows/ingest-riksdagen.yml` | Created — daily 03:00 UTC |
| `.github/workflows/ingest-esv.yml` | Created — weekly Monday 04:00 UTC |
| `.github/workflows/ingest-manifesto.yml` | Created — `workflow_dispatch` only |
| `.github/workflows/embed.yml` | Created — triggers after any ingest workflow succeeds |

---

## Architecture

```
GitHub Actions (scheduled)
       │
       ├── ingest-riksdagen.yml  (daily 03:00 UTC)
       │       └─▶ scripts/ingest/riksdagen.ts
       │               ├─▶ members.ts      → members
       │               ├─▶ documents.ts    → documents, document_authors
       │               └─▶ voting.ts       → votes, vote_results
       │
       ├── ingest-esv.yml  (weekly Monday 04:00 UTC)
       │       └─▶ scripts/ingest/esv.ts  → budget_outcomes
       │
       ├── ingest-manifesto.yml  (manual dispatch)
       │       └─▶ scripts/ingest/manifesto.ts → manifestos, manifesto_statements
       │
       └── embed.yml  (triggers on success of any above)
               └─▶ scripts/embed/generate-embeddings.ts
                       ├─▶ manifesto_statements.embedding  (voyage-4-lite, 1024 dims)
                       └─▶ document_chunks.embedding       (chunked from document_texts)

All runs → ingestion_runs table (source, status, timestamps, counts, errors)
```

---

## Data Sources

| Source | Endpoint | Schedule | Tables populated |
|--------|----------|----------|-----------------|
| Riksdagen Open Data | `data.riksdagen.se` | Daily | `members`, `documents`, `document_authors`, `votes`, `vote_results` |
| ESV budget CSVs | `esv.se/psidata/arsutfall/` | Weekly | `budget_outcomes` |
| Manifesto Project API | `manifesto-project.wzb.eu/api/v1/` | Manual | `manifestos`, `manifesto_statements` |
| Voyage AI | `api.voyageai.com` | After ingest | `manifesto_statements.embedding`, `document_chunks.embedding` |

---

## Verification Queries

Run these in the Supabase SQL Editor after the first successful ingestion:

```sql
-- Members
SELECT COUNT(*) FROM members WHERE status = 'active';
-- Expected: ~349

-- Documents by type
SELECT type, COUNT(*) FROM documents GROUP BY type ORDER BY COUNT(*) DESC;
-- Expected: mot highest, then prop, bet, ip, fr

-- Votes
SELECT COUNT(*) FROM votes;
SELECT COUNT(*) FROM vote_results;

-- Budget
SELECT year, COUNT(*) FROM budget_outcomes GROUP BY year ORDER BY year DESC;
-- Expected: rows for each of the last 10 years

-- Manifestos
SELECT party_code, election_year, COUNT(ms.id) AS statements
FROM manifestos m
LEFT JOIN manifesto_statements ms ON ms.manifesto_id = m.id
GROUP BY party_code, election_year
ORDER BY election_year DESC, party_code;
-- Expected: 8 parties × up to 4 election years

-- Embeddings (after embed workflow)
SELECT COUNT(*) FROM manifesto_statements WHERE embedding IS NOT NULL;
SELECT COUNT(*) FROM document_chunks WHERE embedding IS NOT NULL;

-- Ingestion audit
SELECT source, status, records_processed, started_at, completed_at
FROM ingestion_runs ORDER BY started_at DESC LIMIT 10;
```

---

## What This RFC Does NOT Cover

- API endpoints that consume this data — RFC-05 (core endpoints) and RFC-06 (search)
- Rate limiting middleware — RFC-04 (API keys)
- The `speeches` table — not ingested in this request to keep daily run time manageable;
  the table schema is ready and a separate workflow can be added when needed
- Historical backfill beyond the two most recent riksmöten — manual one-off operation

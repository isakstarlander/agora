# RFC-03a — Document Text Body Ingestion

| Field  | Value |
|--------|-------|
| Status | Implemented |
| Date   | 2026-04-09 |
| Author | GitHub Copilot |
| Spec   | `api-first/03-ingestion-appendix.md` |

---

## Summary

Added a fourth step to the Riksdagen ingestion orchestrator that fetches the HTML body
behind every `document_url` in `documents`, strips it to plain text, and upserts the
result into `document_texts`. This unblocks the hybrid vector search function
`search_documents`, which joins `document_texts` for full-text ranking and
`document_chunks` for vector similarity. Runs are incremental — documents that already
have a `document_texts` row are skipped, so subsequent daily runs process only newly
ingested documents and complete well within the 60-minute GitHub Actions timeout.

---

## Motivation

PR-03 populated `documents` including `document_url`, but never fetched the HTML behind
those URLs. As a result `document_texts` was empty, `document_chunks` had no source
material to chunk, and `search_documents` returned no results. The first full run
(~12,000 documents × 1.1 s ≈ 3.7 h) must be run locally; all subsequent runs are fast.

---

## Decisions

### Protocol-relative URLs normalised to `https:`

Several `document_url` values stored in the database use the protocol-relative form
`//data.riksdagen.se/dokument/<id>.html`. The native `fetch` API does not accept
protocol-relative URLs (`ERR_INVALID_URL`). Before each fetch the URL is normalised:

```typescript
const url = doc.document_url.startsWith('//')
  ? `https:${doc.document_url}`
  : doc.document_url
```

### Native `fetch` instead of `fetchRiksdagen()`

`fetchRiksdagen()` in `utils.ts` is JSON-only and includes Riksdagen-specific retry
logic designed for the API endpoints. Document HTML is plain HTTP — native `fetch` with
`AbortSignal.timeout(20_000)` is the right tool. Per-document errors are caught,
logged, and skipped without aborting the run.

### Rate: 1 request per ~1.1 seconds

A 1100 ms sleep between fetches yields ~0.9 req/s, consistent with the ≤1 req/s
guideline in `foundation.md §7.1` for Riksdagen's servers.

### `body_html` stored alongside `body_text`

The raw HTML is stored in `body_html` to allow future re-extraction strategies (e.g.
extracting structured sections or metadata) without re-fetching from Riksdagen.

---

## Files Created / Changed

| File | Change |
|---|---|
| `scripts/ingest/document-texts.ts` | Created — `ingestDocumentTexts()` |
| `scripts/ingest/riksdagen.ts` | Added import + step 4 inside `try` block after votes |
| `scripts/package.json` | Added `node-html-parser` dependency |

---

## Architecture

```
scripts/ingest/riksdagen.ts  (orchestrator — unchanged except step 4)
       │
       ├── step 1: members.ts        → members
       ├── step 2: documents.ts      → documents, document_authors
       ├── step 3: voting.ts         → votes, vote_results
       └── step 4: document-texts.ts → document_texts          ← new
               │
               ├─ pages documents WHERE document_url IS NOT NULL (100/page)
               ├─ skips document_id already present in document_texts (incremental)
               ├─ fetches HTML via native fetch (AbortSignal.timeout 20s)
               ├─ strips HTML to plain text via node-html-parser
               └─ upserts { document_id, body_html, body_text, word_count, language }
```

After `document_texts` is populated, `npm run embed` chunks `body_text` into
`document_chunks` and generates `embedding vector(1024)`, enabling
`search_documents()` to return results.

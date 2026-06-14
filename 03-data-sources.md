# 03 — Data sources

This document is the reference for every external datum that flows into Agora. It is intentionally self-contained so that an implementer never has to leave this folder to understand what we're ingesting and why we are allowed to.

Agora depends on **three upstream open-data providers**:

1. **`data.riksdagen.se`** — the Riksdag's own open-data service. Source of documents (motions, propositions, committee reports, interpellations, framställningar, minutes), recorded votes, members of the Riksdag, and speeches.
2. **`statskontoret.se`** — Statskontoret's *OpenData* årsutfall CSV feed (successor to ESV's feed). Source of state-budget expenditure outturns (utfall) per expenditure area (utgiftsområde) and budget line (anslag), 1997 → present.
3. **`manifesto-project.wzb.eu`** — the Manifesto Project at WZB Berlin. Source of coded party-election manifestos for the eight sitting Swedish parties across the last four general elections (2010, 2014, 2018, 2022).

Sections 2, 3, and 4 document each in turn. Section 1 explains the legal and ethical framing that lets us re-use this data.

## 1. Legal framing

### 1.1 Offentlighetsprincipen

*Offentlighetsprincipen*, "the principle of public access", is the Swedish constitutional principle that official documents are public by default. It is enshrined in *Tryckfrihetsförordningen* (the Freedom of the Press Act), 2 kap., and operationalised in *Offentlighets- och sekretesslagen* (2009:400).

For Agora specifically this means:

- The content of motions, propositions, voting records, minutes, committee reports, interpellations, budget outturns, and the personal identifiers of sitting MPs (name, birth year, party, constituency) is **public data**.
- We do not need consent from individual MPs to display their voting records, speeches, or motion authorship.
- The data is published by the Riksdag itself at `data.riksdagen.se` under an explicit open-data policy (see 1.2). We re-use that data and do not scrape the public-facing site.

### 1.2 Upstream licensing

| Provider | Terms (summary as of May 2025) | Attribution we render |
|---|---|---|
| Sveriges riksdag (`data.riksdagen.se`) | Free to use, including commercially. Attribution requested. No warranty. | "Källa: Sveriges riksdag (data.riksdagen.se)" in page footers and on every fact-bearing widget. |
| Statskontoret (`statskontoret.se`) | Public-sector information, free to reuse under *förordning (2008:31) om myndigheters elektroniska tillgång till varandras information* and the Swedish PSI-lagen. | "Källa: Statskontoret, årsutfall utgifter" on budget views. |
| Manifesto Project at WZB | Free for research and public-interest use; requires attribution to *Volkens, Andrea et al., The Manifesto Data Collection, Manifesto Project (MRG/CMP/MARPOR), Wissenschaftszentrum Berlin für Sozialforschung (WZB)* and inclusion of the corpus version. | Cited in full on `/metodik/manifest` and in the footer of every generated accountability report. |

Agora's UI includes a persistent footer: "Agora is an independent civic-tech project and is not affiliated with the Riksdag, Statskontoret, or the Manifesto Project." Every individual view that displays a fact links to the underlying primary document.

### 1.3 GDPR posture

The personal data in scope (names of sitting MPs, their votes, their authored motions, their speeches) is already public under *offentlighetsprincipen* and qualifies for the *public-interest / exercise of official authority* lawful basis in GDPR Art. 6(1)(e), plus Art. 85 (processing for journalistic / academic / artistic / literary purposes) for the summary and accountability layers. We do **not** collect PII from site visitors:

- No accounts, no login.
- No third-party analytics.
- No cookies beyond strictly functional (none at MVP).
- CloudFront access logs are retained 30 days, aggregated, and deleted.

These decisions are revisited in `09-observability-and-security.md`.

## 2. Primary source — `data.riksdagen.se`

Riksdagen's open-data service exposes several endpoints. Each returns XML by default; most accept `&utformat=json` for JSON. All are idempotent GETs and support cursor-style pagination via `p=` (page) and `sz=` (page size).

Below is the endpoint reference we depend on. If Riksdagen changes these paths or parameters, **this is the document to update** and `05-ingestion.md` is the code to update — nowhere else.

### 2.1 Dokumentlista — `GET /dokumentlista/`

Lists all documents (motions, propositions, committee reports, interpellations, etc.).

Key query parameters we use:

| Param | Meaning | Example |
|---|---|---|
| `doktyp` / `typ` | Document type | see table below |
| `rm` | Riksmöte (session) | `2024/25` |
| `from` | Date lower bound | `2024-09-01` |
| `tom` | Date upper bound | `2025-06-30` |
| `sort` | Sort field | `datum` |
| `sortorder` | Sort direction | `desc` |
| `utformat` | Output format | `json` |
| `p` | Page number | `1` |
| `sz` | Page size (max 500) | `200` |

Doctypes Agora ingests:

| Code | Full name | What it is |
|---|---|---|
| `mot` | Motion | Private-members-bill equivalent. A proposal submitted by one or more MPs. |
| `prop` | Proposition | A bill proposed by the government. |
| `bet` | Betänkande | A committee report on a matter before the chamber; contains the committee's recommendation and reservations (dissents). |
| `skr` | Skrivelse | A government communication to the Riksdag that does not propose legislation. |
| `ip` | Interpellation | A formal oral question from an MP to a minister, answered in the chamber. |
| `fr` | Framställning | A non-government proposal from bodies such as Riksdagens styrelse, Riksrevisionen, or Riksbankens fullmäktige. |
| `prot` | Protokoll | Chamber minutes. Ingested as pointers only; full text is fetched on demand. |

Response shape (abridged):

```json
{
  "dokumentlista": {
    "@traff": "4231",
    "@sidor": "22",
    "@sida": "1",
    "@nasta_sida": "https://data.riksdagen.se/dokumentlista/?...&p=2",
    "dokument": [
      {
        "id": "HB02MOT1234",
        "rm": "2024/25",
        "beteckning": "1234",
        "doktyp": "mot",
        "typ": "mot",
        "titel": "Motion om ...",
        "undertitel": "",
        "datum": "2024-10-03",
        "organ": "FiU",
        "dok_id": "HB02MOT1234",
        "dokument_url_text": "https://data.riksdagen.se/dokument/HB02MOT1234",
        "dokument_url_html": "https://data.riksdagen.se/dokument/HB02MOT1234.html",
        "publicerad": "2024-10-04T09:12:00"
      }
    ]
  }
}
```

Ingestion strategy: page through in descending date order per `(typ, rm)`, stop when we hit a document we already have (cursor in DynamoDB per `typ`). See `05-ingestion.md` §2.

### 2.2 Voteringlista — `GET /voteringlista/`

Lists recorded votes.

Key query parameters:

| Param | Meaning |
|---|---|
| `rm` | Riksmöte |
| `bet` | Committee code |
| `punkt` | Voting point number |
| `utformat` | `json` |
| `gruppering` | `iid` (per individual MP) |

Each *voteringsrad* represents one MP's position on one vote point. Fields we persist per row: `votering_id`, `rm`, `beteckning`, `punkt`, `namn`, `intressent_id`, `parti`, `valkrets`, `rost` (`Ja`, `Nej`, `Avstår`, `Frånvarande`), `datum`, `avser` (usually the `bet`/`prop` dok_id).

Ingestion strategy: fetch per-`rm` daily; idempotent on `(votering_id, intressent_id)`. We split the stream into two canonical tables on write: `votes` (one row per vote event, i.e. per `votering_id`) and `vote_results` (one row per MP per vote event). See `04-data-model.md` §4.

### 2.3 Personlista — `GET /personlista/`

Lists members of the Riksdag, current and historical.

Key params: `iid`, `fnamn`, `enamn`, `parti`, `valkrets`, `utformat=json`.

Fields persisted: `intressent_id`, `fnamn` (first name), `enamn` (surname), `sorteringsnamn`, `parti`, `valkrets`, `kon`, `fodd_ar`, `status` (e.g., *Tjänstgörande riksdagsledamot*), optionally `bild_url_80`.

Ingestion strategy: full refresh nightly; the member population is small (~350 sitting MPs + historical). Turnover during a mandate period is on the order of a few dozen rows, so a full-replace is cheaper than diffing.

### 2.4 Document authorship — embedded in dokument detail

Motion authorship (which MPs authored which motion) is not exposed as a dedicated list endpoint. It lives inside the per-document XML at `GET /dokument/{dok_id}` under the `dokument/intressent` node (or, for older documents, inside the HTML body's metadata block).

Agora fetches document detail at ingest time for all `mot` rows and persists an `document_authors` many-to-many linking `dok_id` to `intressent_id` with an `ordning` (author order, first-named = primary author). Propositions (`prop`) have a government author, not a person, so `document_authors` is empty for them; the `organ` field in the document row carries the responsible ministry.

This enables the accountability endpoint's "motions submitted by *this party* on *this topic*" slice — without document_authors, we cannot attribute motions to a party at all for mixed-authorship cases. It was a gap in the first iteration of the existing implementation and is preserved here as a first-class concept.

### 2.5 Anforandelista — `GET /anforandelista/`

Lists speeches given in the chamber.

Key params: `rm`, `anftyp`, `iid`, `parti`, `d` (date, `YYYY-MM-DD`), `from`, `tom`, `utformat=json`.

Response (abridged):

```json
{
  "anforandelista": {
    "@traff": "1842",
    "anforande": [
      {
        "dok_id":        "HB02PROT15",
        "anforande_id":  "abc123",
        "anforande_nummer": "42",
        "talare":        "Anna Andersson (S)",
        "intressent_id": "012345678901",
        "parti":         "S",
        "dok_datum":     "2024-11-12",
        "anforandetext": "Herr talman!..." ,
        "rel_dok_id":    "HB02MOT1234"
      }
    ]
  }
}
```

Ingestion strategy at MVP: we persist **metadata only** (timestamp, speaker, party, length in characters, linked dokument) into a `speeches` Parquet table, and derive monthly per-MP speaking-time aggregates from it. The full `anforandetext` is fetched on demand when a user drills into an individual speech, and is **not** persisted to the corpus. This keeps the analytical store small while still enabling the charts the dashboard needs (speaking time per MP, per party, per month).

### 2.6 Document full-text — `GET /dokument/{dok_id}.{format}`

Fetches the full text of a document. Formats: `html`, `text`, `xml`, `pdf`.

We fetch `.text` at ingestion time for each `mot`, `prop`, `bet`, `skr`, `ip`, and `fr` with a non-empty body; the text is persisted as an individual gzipped S3 object at `s3://agora-raw/doc-text/{dok_id}.txt.gz`. See `02-architecture.md` §3.3. Summaries and embeddings are computed from this text; they are cached in DynamoDB keyed on `dok_id + model_id` so we pay for the LLM call at most once per document.

### 2.7 Quirks to be aware of

- The `p=` paginator returns a `@nasta_sida` URL; follow that, don't construct the next page manually (parameter ordering has tripped callers in the past).
- Dates use `YYYY-MM-DD` without timezone; treat as Europe/Stockholm.
- The `@traff`, `@sidor`, `@sida` fields are strings, not numbers.
- JSON field names are mostly lowercase Swedish, sometimes with underscores.
- `doktyp` and `typ` both appear in responses; they carry the same value for our purposes. The existing implementation uses `typ` as the query parameter; `doktyp` also works.
- Some historical documents are missing `publicerad` timestamps; we fall back to `datum`.
- `Frånvarande` in `voteringar` distinguishes an absent MP from one who voted `Avstår` (abstain). Attendance metrics must use the `Frånvarande` flag, not a missing row.
- When a `dokumentlista` response has exactly one hit, `dokument` is a bare object, not an array. Ingestion must normalise both shapes (the existing implementation's `Array.isArray(dokument) ? dokument : [dokument]` pattern is preserved in the port).

## 3. Primary source — Statskontoret årsutfall (budget)

### 3.1 Endpoint

Until 2024 the feed lived at `esv.se`. Since 2025 it has migrated to Statskontoret. Agora consumes the current URL pattern:

```
https://www.statskontoret.se/OpenDataArsUtfallPage/GetFile
    ?documentType=Utgift
    &fileType=Zip
    &fileName=<percent-encoded filename>
    &Year=<year>
    &month=0
    &status=Definitiv
```

The `fileName` parameter encodes a Swedish-language string, e.g. `"Årsutfall utgifter 1997 - 2024, definitivt.zip"`. One download covers every year from 1997 up to the file year: a single HTTP GET replaces the old per-year loop.

Because the newest year's definitiv file is typically published several months after year-end, the ingest probes backwards: it tries `year = currentYear - 1` first, then `currentYear - 2`, then `currentYear - 3`. The first URL that returns `HTTP 200` with a content-length above 1 KB is used. (The implementation's approach, preserved here.)

### 3.2 File format

The ZIP contains one or more UTF-8, semicolon-delimited CSV files. Columns we read:

| Column | Type | Notes |
|---|---|---|
| `Utgiftsområde` | string, e.g. `"UO14"` | Expenditure-area code. Rows without this are summary rows (Utgiftstak, Marginal, etc.) and are skipped. |
| `Utgiftsområdesnamn` | string | Area name, e.g. `"Arbetsmarknad och arbetsliv"`. |
| `Anslag` | string | Budget-line code within the area. |
| `Anslagsnamn` | string | Budget-line name. |
| `År` | integer | Fiscal year. |
| `Utfall` | decimal | Realised outturn, **MSEK**, Swedish decimal comma. Agora normalises to SEK (× 1,000,000). |
| `Statens budget` | decimal | Original appropriation. Ingested into a sibling row with `budget_type = 'budgetram'`. |
| `Ändringsbudgetar` | decimal | Mid-year amendments; optional, aggregated on-demand. |

Rows are per `(year, utgiftsområde, anslag)`; there is no monthly breakdown in the annual file — Agora stores `month = 0` as a full-year sentinel.

### 3.3 Agora's canonical table

Normalised into `budget_outcomes` (see `04-data-model.md` §8):

```
{
  year,                      // int, e.g. 2024
  month,                     // 0 (annual)
  expenditure_area_code,     // "UO14"
  expenditure_area_name,     // "Arbetsmarknad och arbetsliv"
  anslag_code,               // nullable
  anslag_name,               // nullable
  agency,                    // null for now; kept for future compatibility
  amount_sek,                // float64 SEK
  budget_type                // "utfall" | "budgetram" | "andringsbudget"
}
```

Unique key: `(year, month, anslag_code, budget_type)`. A rebuild is safe because the same `(year, anslag_code, budget_type)` appears in later-year files; we always upsert.

### 3.4 Ingestion cadence

Monthly, not daily. The source is only refreshed when Statskontoret publishes a new *definitiv* file (typically once a year, in Q2, with occasional corrections). See `05-ingestion.md` §4.

## 4. Primary source — Manifesto Project at WZB

### 4.1 What we get

The Manifesto Project maintains a hand-coded corpus of party manifestos from ~60 democracies since WWII. For Sweden it covers the eight currently-sitting parliamentary parties across every general election since 1944. Each manifesto is broken into "quasi-sentences" (statements), and each statement is coded against a 56-category policy schema (`per101`–`per706`), plus a signed `pos` score that places the statement on a pro-/anti-/neutral axis for its category.

The coded quasi-sentences are what makes the accountability endpoint possible: "this party promised X about welfare" becomes a concrete search over statements with `category_code ∈ {504, 505, …}` for manifestos belonging to that party.

### 4.2 Endpoint

Base: `https://manifesto-project.wzb.eu/api/v1`

Relevant operations:

| Operation | Purpose |
|---|---|
| `GET /list_metadata_versions` | Enumerate published corpus versions (e.g. `"2024-1"`, `"2025-1"`). Agora always targets the latest. |
| `GET /texts_and_annotations?api_key=...&keys[]={party}_{YYYYMM}&version=...` | Return the coded statements for one party-election. |

An API key is required; obtained once via free account at `manifesto-project.wzb.eu` and stored as the secret `AGORA_MANIFESTO_API_KEY` in Secrets Manager. Key is read-only and single-purpose.

Swedish parties and their Manifesto Project IDs:

| Party code (Agora) | Manifesto ID | Name |
|---|---|---|
| `S`  | `11320` | Socialdemokraterna |
| `M`  | `11620` | Moderaterna |
| `SD` | `11710` | Sverigedemokraterna |
| `C`  | `11810` | Centerpartiet |
| `V`  | `11220` | Vänsterpartiet |
| `KD` | `11520` | Kristdemokraterna |
| `L`  | `11420` | Liberalerna (formerly Folkpartiet) |
| `MP` | `11110` | Miljöpartiet |

Election months: Swedish general elections are held in September, so keys are `{manifesto_id}_{year}09` for each of 2010, 2014, 2018, 2022. 2026 will be added after the September 2026 election once WZB codes it (typically ~6 months post-election).

### 4.3 Response shape (abridged)

```json
{
  "items": [
    {
      "key": "11320_202209",
      "items": [
        { "text": "Vi ska halvera arbetslösheten...", "cmp_code": "504",  "pos":  1 },
        { "text": "Skatter ska sänkas för låginkomsttagare", "cmp_code": "402",  "pos":  1 },
        { "text": "NATO-medlemskap avvisas",              "cmp_code": "107",  "pos": -1 }
      ]
    }
  ],
  "missing_items": []
}
```

### 4.4 Agora's canonical tables

Normalised into two tables (see `04-data-model.md` §9):

- `manifestos` — one row per `(party_code, election_year)`; metadata (party name, ingestion date, corpus version).
- `manifesto_statements` — one row per coded quasi-sentence; fields `manifesto_id`, `statement_index` (0-based position in the manifesto), `text`, `category_code`, `position ∈ {-1, 0, 1}`.

### 4.5 Ingestion cadence

Triggered by hand (or by a scheduled check against `/list_metadata_versions`) once every few months — the corpus is updated roughly twice a year. A cold full-rebuild takes under a minute since the total payload for Sweden is ~30 MB of JSON. See `05-ingestion.md` §5.

## 5. Derived datasets Agora builds

From the three primary sources, we derive and store in our Parquet lake:

1. **`votes_wide`** — one row per `(votering_id, intressent_id)` enriched with party, committee, proposition title, and a boolean `voted_against_own_party`.
2. **`party_cohesion`** — per `(rm, parti, betänkande)`, the percentage of MPs voting with the party line.
3. **`party_divergence`** — per `(rm, parti_a, parti_b, betänkande)`, the percentage of vote points where the two parties differed.
4. **`attendance_monthly`** — per `(intressent_id, year, month)`, attendance ratio.
5. **`motion_throughput`** — per `(rm, utskott)`, counts of motions submitted, reported on, and approved.
6. **`document_chunks`** — per document, 800-token chunks of the gzipped full text; keyed on `(dok_id, chunk_index)`. Feeds the embedding pipeline.
7. **`document_embeddings`** — per `(dok_id, chunk_index)`, a 1024-dim vector from Titan Embed v2 (see `08-llm-layer.md`).
8. **`speech_monthly`** — per `(intressent_id, year, month)`, number of speeches and total character count.
9. **`budget_by_area`** — per `(year, expenditure_area_code, budget_type)`, aggregated `amount_sek` across all `anslag`. Small table, precomputed for fast area-level charts.
10. **`manifesto_by_category`** — per `(party_code, election_year, category_code)`, count of statements and average `position`. Precomputed to avoid repeat aggregations in the accountability endpoint.

Each derived dataset is a pure function of the raw data; a full rebuild from the immutable S3 raw prefix is explicitly supported (see `05-ingestion.md`, section "Rebuilds").

## 6. Sources deliberately not ingested in MVP

- **Kommittérapporter and SOU:er (official public inquiries).** Related to parliamentary work but published by `regeringen.se`, not `data.riksdagen.se`. Out of scope for the dashboard's first release; candidate for post-MVP.
- **Speaking-time full text at corpus scale.** We ingest metadata only; storing all `anforandetext` blobs would roughly double the corpus size for marginal value at MVP (dashboard widgets are aggregates, not full-text speech search). Post-MVP candidate.
- **SCB (Statistics Sweden).** Out of scope: Agora is about parliamentary *actions*, not country-level statistics. If later we want to plot "MP votes vs. SCB unemployment rates", that can be a small, well-scoped extension.
- **News coverage, party press releases, social media.** Out of scope permanently. Editorially and legally messy.
- **Monthly budget outturns** (ESV/Statskontoret also publish these). The annual definitiv file is sufficient for period-scoped comparisons at MVP; monthly granularity multiplies row count by ~12 for no user-visible gain in the dashboard's current scope.

## 7. Local caching & rate-limit courtesy

All three upstreams are public and generous but a well-behaved citizen caches. Agora's ingestion Lambdas:

- Send an explicit `User-Agent: AgoraBot/1.0 (+https://<site>; contact: <email>)`.
- Honour `Last-Modified` and `ETag`, using conditional GETs (`If-Modified-Since`) where the upstream supports them.
- Sleep 200 ms between paginated Riksdagen requests, 1,500 ms between Manifesto Project requests (the WZB API is noticeably slower and small-team-operated).
- Cap a single Lambda run at 13 minutes wall-clock (2-minute safety margin against the 15-minute hard limit); if the backlog is larger, the run exits cleanly and the next scheduled run resumes via the DynamoDB cursor.
- Record every run in `ingestion_runs` (see `04-data-model.md` §10) with started/finished timestamps, source, rows processed/inserted, and any error payloads. This is the single source of truth for "did last night's ingestion succeed?".

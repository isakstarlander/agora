import { z } from 'zod'
import {
  getSupabaseClient,
  startIngestionRun,
  finishIngestionRun,
  sleep,
} from './utils.js'

const API_KEY  = process.env.MANIFESTO_API_KEY
const BASE_URL = 'https://manifesto-project.wzb.eu/api/v1'

if (!API_KEY || API_KEY.trim() === '') {
  console.error('MANIFESTO_API_KEY is not set')
  process.exit(1)
}

const SWEDISH_PARTIES = [
  { manifesto_id: '11320', agora_code: 'S',  name: 'Socialdemokraterna' },
  { manifesto_id: '11620', agora_code: 'M',  name: 'Moderaterna' },
  { manifesto_id: '11710', agora_code: 'SD', name: 'Sverigedemokraterna' },
  { manifesto_id: '11810', agora_code: 'C',  name: 'Centerpartiet' },
  { manifesto_id: '11220', agora_code: 'V',  name: 'Vänsterpartiet' },
  { manifesto_id: '11520', agora_code: 'KD', name: 'Kristdemokraterna' },
  { manifesto_id: '11420', agora_code: 'L',  name: 'Liberalerna' },
  { manifesto_id: '11110', agora_code: 'MP', name: 'Miljöpartiet' },
]

const ELECTION_YEARS = [2022, 2018, 2014, 2010]
// Swedish national elections are always held in September
const ELECTION_MONTH: Record<number, string> = { 2022: '09', 2018: '09', 2014: '09', 2010: '09' }

/** Fetch the latest corpus metadata version string (e.g. "2025-1"). */
async function fetchLatestVersion(): Promise<string> {
  const res = await fetch(`${BASE_URL}/list_metadata_versions`)
  if (!res.ok) throw new Error(`Could not fetch corpus versions: HTTP ${res.status}`)
  const json = await res.json() as string[] | { versions?: string[] }
  const versions = Array.isArray(json) ? json : (json.versions ?? [])
  const latest = versions.at(-1)
  if (!latest) throw new Error('No corpus versions found')
  return latest
}

const TextItemSchema = z.object({
  text:     z.string(),
  cmp_code: z.string().nullable().optional(),
  pos:      z.number().nullable().optional(),
})

type TextItem = z.infer<typeof TextItemSchema>

async function fetchManifestoTexts(
  partyId: string,
  electionYear: number,
  version: string,
): Promise<TextItem[]> {
  const month = ELECTION_MONTH[electionYear] ?? '09'
  const key   = `${partyId}_${electionYear}${month}`
  const url   = `${BASE_URL}/texts_and_annotations?api_key=${API_KEY}&keys[]=${key}&version=${version}`
  const res   = await fetch(url)
  if (!res.ok) {
    if (res.status === 404) return []
    throw new Error(`Manifesto API HTTP ${res.status} for key ${key} (version ${version})`)
  }
  const json = await res.json() as { items?: Array<{ items?: unknown[] }>; missing_items?: string[] }
  if (!json.items?.length) return []
  // Each entry in items[] corresponds to one requested key; its .items[] is the statement list
  const allItems: unknown[] = json.items.flatMap(entry => entry.items ?? [])
  return allItems.map(item => TextItemSchema.parse(item))
}

async function main() {
  const client = getSupabaseClient()
  const runId  = await startIngestionRun(client, 'manifesto')
  const errors: unknown[] = []
  let totalInserted = 0

  const version = await fetchLatestVersion()
  console.log(`Using Manifesto corpus version: ${version}`)

  for (const year of ELECTION_YEARS) {
    for (const party of SWEDISH_PARTIES) {
      console.log(`  Fetching ${party.agora_code} ${year}...`)
      try {
        const items = await fetchManifestoTexts(party.manifesto_id, year, version)
        if (items.length === 0) {
          console.log(`  No data for ${party.agora_code} ${year}, skipping.`)
          continue
        }

        // Upsert manifesto record
        const { data: manifestoData, error: manifestoError } = await client
          .from('manifestos')
          .upsert(
            {
              party_code:    party.agora_code,
              party_name:    party.name,
              election_year: year,
              ingested_at:   new Date().toISOString(),
            },
            { onConflict: 'party_code,election_year' },
          )
          .select('id')
          .single()

        if (manifestoError) throw manifestoError
        const manifestoId = manifestoData.id

        // Upsert new statements by (manifesto_id, statement_index), then delete any rows
        // with a higher index than the new total (handles manifestos that shrink on refresh).
        // This avoids a delete→insert gap where data would be temporarily absent.
        const BATCH = 200
        const statements = items.map((item, idx) => ({
          manifesto_id:    manifestoId,
          text:            item.text,
          category_code:   item.cmp_code ?? null,
          position:        item.pos != null ? (item.pos > 0 ? 1 : item.pos < 0 ? -1 : 0) : null,
          statement_index: idx,
        }))

        for (let i = 0; i < statements.length; i += BATCH) {
          const batch = statements.slice(i, i + BATCH)
          const { error } = await client
            .from('manifesto_statements')
            .upsert(batch, { onConflict: 'manifesto_id,statement_index', ignoreDuplicates: false })
          if (error) throw error
          totalInserted += batch.length
        }

        // Prune any stale rows beyond the new statement count (e.g. manifesto was revised shorter)
        await client
          .from('manifesto_statements')
          .delete()
          .eq('manifesto_id', manifestoId)
          .gte('statement_index', statements.length)

        console.log(`  ${party.agora_code} ${year}: ${items.length} statements`)
        await sleep(1500)
      } catch (err) {
        console.warn(`  Failed: ${party.agora_code} ${year}:`, err)
        errors.push({ party: party.agora_code, year, error: String(err) })
      }
    }
  }

  await finishIngestionRun(client, runId, {
    processed: totalInserted,
    inserted:  totalInserted,
    updated:   0,
  }, errors)

  console.log(`Manifesto ingestion complete. Statements: ${totalInserted}`)
  if (errors.length > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

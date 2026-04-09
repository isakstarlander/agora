import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve .env.local relative to the monorepo root (three levels up from scripts/ingest/utils.ts)
const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
config({ path: resolve(repoRoot, '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY  = process.env.SUPABASE_SECRET_KEY!

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY')
  process.exit(1)
}

export function getSupabaseClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  })
}

/** Start an ingestion run, returns the run ID */
export async function startIngestionRun(
  client: SupabaseClient,
  source: string,
): Promise<number> {
  const { data, error } = await client
    .from('ingestion_runs')
    .insert({ source, status: 'running' })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

/** Finish an ingestion run */
export async function finishIngestionRun(
  client: SupabaseClient,
  runId: number,
  counts: { processed: number; inserted: number; updated: number },
  errors?: unknown[],
): Promise<void> {
  await client
    .from('ingestion_runs')
    .update({
      completed_at:      new Date().toISOString(),
      records_processed: counts.processed,
      records_inserted:  counts.inserted,
      records_updated:   counts.updated,
      errors:            errors?.length ? errors : null,
      status:            errors?.length ? 'failed' : 'success',
    })
    .eq('id', runId)
}

/** Sleep helper for rate limiting */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Fetch JSON from Riksdagen API with retry and per-request timeout */
export async function fetchRiksdagen<T>(url: string, retries = 5): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        // 30s timeout per attempt — prevents silent hangs on dropped connections
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
      return await res.json() as T
    } catch (err) {
      if (attempt === retries) throw err
      // Exponential backoff: 5s, 10s, 20s, 40s between attempts
      const delay = 5_000 * Math.pow(2, attempt - 1)
      console.warn(`  Riksdagen fetch failed (attempt ${attempt}/${retries}), retrying in ${delay / 1000}s:`, (err as Error).message)
      await sleep(delay)
    }
  }
  throw new Error('Unreachable')
}

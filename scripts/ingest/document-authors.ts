import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchRiksdagen, sleep } from './utils.js'

// Only these types have named member authors
const AUTHOR_TYPES  = ['mot', 'ip', 'fr']
const SLEEP_MS      = 1_100  // ~0.9 req/s
const IN_BATCH_SIZE = 500    // max IDs per .in() to stay within PostgREST URL limits

interface RiksdagenIntressent {
  intressent_id: string
  roll: string
}

interface DokumentstatusResponse {
  dokumentstatus: {
    dokintressent?: {
      intressent: RiksdagenIntressent | RiksdagenIntressent[]
    }
  }
}

/**
 * Fetches document authors for mot/ip/fr documents in the target riksmöten that
 * have no entry in document_authors yet.
 * Never throws — individual failures are warned and skipped.
 */
export async function ingestDocumentAuthors(
  client: SupabaseClient,
  rms: string[],
): Promise<{ inserted: number; skipped: number }> {
  console.log('  Fetching document authors...')

  // All mot/ip/fr documents for the target riksmöten.
  const { data: docs, error: docsError } = await client
    .from('documents')
    .select('id')
    .in('type', AUTHOR_TYPES)
    .in('rm', rms)
    .order('id')

  if (docsError) throw docsError
  if (!docs || docs.length === 0) {
    console.log('  Document authors: nothing to process')
    return { inserted: 0, skipped: 0 }
  }

  // Fetch already-ingested document IDs in batches.
  const docIds = docs.map(d => d.id)
  const ingestedIds = new Set<string>()
  for (let i = 0; i < docIds.length; i += IN_BATCH_SIZE) {
    const { data: existing, error: existingError } = await client
      .from('document_authors')
      .select('document_id')
      .in('document_id', docIds.slice(i, i + IN_BATCH_SIZE))
    if (existingError) throw existingError
    existing?.forEach(r => ingestedIds.add(r.document_id))
  }

  const toProcess = docs.filter(d => !ingestedIds.has(d.id))
  console.log(`  Document authors: ${ingestedIds.size} already ingested, ${toProcess.length} to fetch`)

  let totalInserted = 0
  let totalSkipped  = 0

  for (const doc of toProcess) {
    try {
      const data = await fetchRiksdagen<DokumentstatusResponse>(
        `https://data.riksdagen.se/dokumentstatus/${doc.id}.json`,
      )

      const raw = data.dokumentstatus.dokintressent?.intressent
      if (!raw) {
        totalSkipped++
        await sleep(SLEEP_MS)
        continue
      }

      const persons    = Array.isArray(raw) ? raw : [raw]
      const authorRows = persons
        .filter(p => p.intressent_id && p.roll?.toLowerCase() === 'undertecknare')
        .map(p => ({ document_id: doc.id, member_id: p.intressent_id }))

      if (authorRows.length > 0) {
        const { error: upsertError } = await client
          .from('document_authors')
          .upsert(authorRows, { onConflict: 'document_id,member_id', ignoreDuplicates: true })
        if (upsertError) {
          console.warn(`    [doc-authors] upsert error for doc ${doc.id}:`, upsertError.message)
          totalSkipped++
          await sleep(SLEEP_MS)
          continue
        }
        totalInserted += authorRows.length
      } else {
        totalSkipped++
      }
    } catch (err) {
      console.warn(`    [doc-authors] Failed for doc ${doc.id}:`, err)
      totalSkipped++
    }

    await sleep(SLEEP_MS)
  }

  console.log(`  Document authors: ${totalInserted} inserted, ${totalSkipped} skipped`)
  return { inserted: totalInserted, skipped: totalSkipped }
}

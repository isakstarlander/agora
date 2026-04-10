import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchRiksdagen, sleep } from './utils.js'

// Only these types have named member authors
const AUTHOR_TYPES = ['mot', 'ip', 'fr']
const PAGE_SIZE    = 100
const SLEEP_MS     = 1_100  // ~0.9 req/s

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
 * Fetches document authors from the Riksdagen dokumentstatus endpoint for all
 * mot/ip/fr documents that have no entry in document_authors yet.
 * Never throws — individual failures are warned and skipped.
 */
export async function ingestDocumentAuthors(
  client: SupabaseClient,
): Promise<{ inserted: number; skipped: number }> {
  let totalInserted = 0
  let totalSkipped  = 0
  let offset        = 0

  console.log('  Fetching document authors...')

  while (true) {
    const { data: docs, error } = await client
      .from('documents')
      .select('id')
      .in('type', AUTHOR_TYPES)
      .order('id')
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) throw error
    if (!docs || docs.length === 0) break

    for (const doc of docs) {
      // Incremental: skip if already has at least one author
      const { count } = await client
        .from('document_authors')
        .select('document_id', { count: 'exact', head: true })
        .eq('document_id', doc.id)

      if ((count ?? 0) > 0) {
        totalSkipped++
        continue
      }

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

        const persons = Array.isArray(raw) ? raw : [raw]
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

    if (docs.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  console.log(`  Document authors: ${totalInserted} inserted, ${totalSkipped} skipped`)
  return { inserted: totalInserted, skipped: totalSkipped }
}

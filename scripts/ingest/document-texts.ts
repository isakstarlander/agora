import type { SupabaseClient } from '@supabase/supabase-js'
import { parse } from 'node-html-parser'
import { sleep } from './utils.js'

const FETCH_TIMEOUT_MS  = 20_000   // 20s per document request
const INTER_FETCH_SLEEP = 1_100    // ~0.9 req/s — respectful of Riksdagen's servers
const IN_BATCH_SIZE     = 500      // max IDs per .in() to stay within PostgREST URL limits

function htmlToText(html: string): string {
  const root = parse(html)
  root.querySelectorAll('script, style').forEach(el => el.remove())
  return root.innerText
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/**
 * Fetches HTML bodies for documents in the target riksmöten that lack a
 * `document_texts` row. Never throws — individual failures are warned and skipped.
 */
export async function ingestDocumentTexts(
  client: SupabaseClient,
  rms: string[],
): Promise<{ inserted: number; skipped: number }> {
  console.log('  Fetching document text bodies...')

  // All documents for the target riksmöten that have a source URL.
  const { data: docs, error: docsError } = await client
    .from('documents')
    .select('id, document_url')
    .in('rm', rms)
    .not('document_url', 'is', null)
    .order('id')

  if (docsError) throw docsError
  if (!docs || docs.length === 0) {
    console.log('  Document texts: nothing to process')
    return { inserted: 0, skipped: 0 }
  }

  // Fetch already-ingested document IDs in batches to avoid URL length limits.
  const docIds = docs.map(d => d.id)
  const ingestedIds = new Set<string>()
  for (let i = 0; i < docIds.length; i += IN_BATCH_SIZE) {
    const { data: existing, error: existingError } = await client
      .from('document_texts')
      .select('document_id')
      .in('document_id', docIds.slice(i, i + IN_BATCH_SIZE))
    if (existingError) throw existingError
    existing?.forEach(r => ingestedIds.add(r.document_id))
  }

  const toProcess = docs.filter(d => d.document_url && !ingestedIds.has(d.id))
  console.log(`  Document texts: ${ingestedIds.size} already ingested, ${toProcess.length} to fetch`)

  let totalInserted = 0
  let totalSkipped  = 0

  for (const doc of toProcess) {
    const url = doc.document_url!.startsWith('//')
      ? `https:${doc.document_url}`
      : doc.document_url!

    try {
      const res = await fetch(url, {
        signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          Accept:       'text/html',
          'User-Agent': 'agora-ingest/1.0',
        },
      })

      if (!res.ok) {
        console.warn(`    [doc-texts] HTTP ${res.status} for doc ${doc.id}, skipping`)
        totalSkipped++
        await sleep(INTER_FETCH_SLEEP)
        continue
      }

      const html     = await res.text()
      const bodyText = htmlToText(html)

      const { error: upsertError } = await client
        .from('document_texts')
        .upsert(
          {
            document_id: doc.id,
            body_text:   bodyText,
            word_count:  wordCount(bodyText),
            language:    'sv',
          },
          { onConflict: 'document_id', ignoreDuplicates: true },
        )

      if (upsertError) throw upsertError
      totalInserted++
    } catch (err) {
      console.warn(`    [doc-texts] Failed for doc ${doc.id}:`, err)
      totalSkipped++
    }

    await sleep(INTER_FETCH_SLEEP)
  }

  console.log(`  Document texts: ${totalInserted} inserted, ${totalSkipped} skipped`)
  return { inserted: totalInserted, skipped: totalSkipped }
}

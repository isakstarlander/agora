import type { SupabaseClient } from '@supabase/supabase-js'
import { parse } from 'node-html-parser'
import { sleep } from './utils.js'

const FETCH_TIMEOUT_MS  = 20_000   // 20s per document request
const INTER_FETCH_SLEEP = 1_100    // ~0.9 req/s — respectful of Riksdagen's servers
const PAGE_SIZE         = 100

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
 * Fetches HTML bodies for all documents that lack a `document_texts` row.
 * Never throws — individual failures are warned and skipped.
 */
export async function ingestDocumentTexts(
  client: SupabaseClient,
): Promise<{ inserted: number; skipped: number }> {
  let totalInserted = 0
  let totalSkipped  = 0
  let offset        = 0

  console.log('  Fetching document text bodies...')

  while (true) {
    // Page through documents that have a URL
    const { data: docs, error } = await client
      .from('documents')
      .select('id, document_url')
      .not('document_url', 'is', null)
      .order('id')
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) throw error
    if (!docs || docs.length === 0) break

    for (const doc of docs) {
      if (!doc.document_url) {
        totalSkipped++
        continue
      }

      // Normalise protocol-relative URLs (e.g. //data.riksdagen.se/...)
      const url = doc.document_url.startsWith('//')
        ? `https:${doc.document_url}`
        : doc.document_url

      // Incremental: skip if already ingested
      const { count } = await client
        .from('document_texts')
        .select('document_id', { count: 'exact', head: true })
        .eq('document_id', doc.id)

      if ((count ?? 0) > 0) {
        totalSkipped++
        continue
      }

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
              body_html:   html,
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

    if (docs.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  console.log(`  Document texts: ${totalInserted} inserted, ${totalSkipped} skipped`)
  return { inserted: totalInserted, skipped: totalSkipped }
}

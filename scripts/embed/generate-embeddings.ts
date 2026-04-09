import { createRequire } from 'node:module'
import { getSupabaseClient, sleep } from '../ingest/utils.js'

// voyageai ships a broken ESM build that tsx cannot resolve on Node ≥24.
// Import it via CJS to bypass the ESM resolver.
const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { VoyageAIClient } = require('voyageai') as typeof import('voyageai')
type EmbedResponseDataItem = import('voyageai').EmbedResponseDataItem

// Single source of truth for embedding dimensions.
// Must match the vector(N) column definition in the DB migrations.
const EMBEDDING_MODEL = 'voyage-4-lite'
const EMBEDDING_DIM   = 1024
const BATCH_SIZE      = 20   // voyage-4-lite: up to 128; free tier (3 RPM) throttles via sleep below
const INTER_BATCH_SLEEP = 22_000  // 22s between calls → stays under 3 RPM on free tier
const CHUNK_SIZE      = 500  // characters per document chunk
const CHUNK_OVERLAP   = 100

const voyage   = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY! })
const supabase = getSupabaseClient()

async function embedTexts(texts: string[], inputType: 'document' | 'query'): Promise<number[][]> {
  const MAX_RETRIES = 6
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await voyage.embed({
        input:           texts,
        model:           EMBEDDING_MODEL,
        inputType,
        outputDimension: EMBEDDING_DIM,
      })
      return response.data!.map((d: EmbedResponseDataItem) => d.embedding!)
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode
      if (statusCode === 429) {
        // Free tier: 3 RPM. Back off 25s per attempt (gives ~60s between retries).
        const delay = (attempt + 1) * 25_000
        console.log(`  [embed] rate-limited, retrying in ${delay / 1000}s…`)
        await sleep(delay)
      } else {
        throw err
      }
    }
  }
  throw new Error('Voyage AI rate limit exceeded after max retries')
}

function chunkText(text: string): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    chunks.push(text.slice(start, start + CHUNK_SIZE))
    start += CHUNK_SIZE - CHUNK_OVERLAP
    if (start + CHUNK_SIZE - CHUNK_OVERLAP >= text.length && start < text.length) {
      chunks.push(text.slice(start))
      break
    }
  }
  return chunks
}

async function embedManifestoStatements(): Promise<void> {
  console.log('[embed] manifesto_statements — fetching unembedded rows...')
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('manifesto_statements')
      .select('id, text')
      .is('embedding', null)
      .range(offset, offset + BATCH_SIZE - 1)

    if (error) throw error
    if (!data || data.length === 0) break

    console.log(`[embed] manifesto batch offset=${offset} count=${data.length}`)
    const embeddings = await embedTexts(data.map(r => r.text), 'document')

    for (let i = 0; i < data.length; i++) {
      const { error: updateError } = await supabase
        .from('manifesto_statements')
        .update({ embedding: embeddings[i] as unknown as string })
        .eq('id', data[i]!.id)
      if (updateError) throw updateError
    }

    if (data.length < BATCH_SIZE) break
    offset += BATCH_SIZE
    await sleep(INTER_BATCH_SLEEP)
  }
  console.log('[embed] manifesto_statements — done')
}

async function embedDocumentChunks(): Promise<void> {
  console.log('[embed] document_chunks — fetching documents without chunks...')

  // Process in pages to avoid loading the entire corpus at once
  const PAGE = 100
  let offset = 0

  while (true) {
    const { data: docs, error } = await supabase
      .from('document_texts')
      .select('document_id, body_text')
      .not('body_text', 'is', null)
      .range(offset, offset + PAGE - 1)

    if (error) throw error
    if (!docs || docs.length === 0) break

    for (const doc of docs) {
      if (!doc.body_text) continue

      // Skip if already chunked
      const { count } = await supabase
        .from('document_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('document_id', doc.document_id)
      if ((count ?? 0) > 0) continue

      const chunks = chunkText(doc.body_text)

      // Embed in sub-batches
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const subChunks = chunks.slice(i, i + BATCH_SIZE)
        const embeddings = await embedTexts(subChunks, 'document')

        const rows = subChunks.map((text, idx) => ({
          document_id: doc.document_id,
          chunk_index: i + idx,
          text,
          embedding:   embeddings[idx] as unknown as string,
        }))

        const { error: upsertError } = await supabase
          .from('document_chunks')
          .upsert(rows, { onConflict: 'document_id,chunk_index', ignoreDuplicates: true })
        if (upsertError) throw upsertError
        await sleep(INTER_BATCH_SLEEP)
      }
    }

    if (docs.length < PAGE) break
    offset += PAGE
  }
  console.log('[embed] document_chunks — done')
}

async function main(): Promise<void> {
  if (!process.env.VOYAGE_API_KEY) {
    console.error('VOYAGE_API_KEY is not set')
    process.exit(1)
  }

  await embedManifestoStatements()
  await embedDocumentChunks()
  console.log('Embedding complete.')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})

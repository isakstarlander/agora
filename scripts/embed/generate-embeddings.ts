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
const EMBEDDING_DIM   = 512
const BATCH_SIZE      = 128  // voyage-4-lite API maximum; reduces round-trips
const DB_WRITE_BATCH  = 20   // rows per upsert — each row is ~2KB of vector data; keep under PostgREST's 8s statement timeout
const INTER_BATCH_SLEEP = 50   // 50ms + ~300ms network ≈ 170 RPM — well within Tier 1's 2000 RPM / 16M TPM limits
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

  while (true) {
    const { data, error } = await supabase
      .from('manifesto_statements')
      .select('id, text')
      .is('embedding', null)
      .limit(BATCH_SIZE)

    if (error) throw error
    if (!data || data.length === 0) break

    console.log(`[embed] manifesto batch count=${data.length}`)
    const embeddings = await embedTexts(data.map(r => r.text), 'document')

    for (let i = 0; i < data.length; i++) {
      const { error: updateError } = await supabase
        .from('manifesto_statements')
        .update({ embedding: embeddings[i] as unknown as string })
        .eq('id', data[i]!.id)
      if (updateError) throw updateError
    }

    // Do NOT advance offset — processed rows gain a non-null embedding and drop
    // out of the IS NULL filter, so the next fetch at offset=0 always returns
    // the next unprocessed batch. Advancing offset would skip rows.
    if (data.length < BATCH_SIZE) break
    await sleep(INTER_BATCH_SLEEP)
  }
  console.log('[embed] manifesto_statements — done')
}

async function embedDocumentChunks(): Promise<void> {
  console.log('[embed] document_chunks — phase 1: inserting text chunks...')

  // Phase 1: Insert chunk rows WITHOUT embeddings. pgvector HNSW does not index
  // NULL values, so these inserts are fast and never hit the statement timeout.
  const PAGE = 200
  let offset = 0

  while (true) {
    const { data: ids, error } = await supabase
      .from('documents')
      .select('id')
      .in('type', ['mot', 'prop', 'bet'])
      .range(offset, offset + PAGE - 1)

    if (error) throw error
    if (!ids || ids.length === 0) break

    for (const { id: documentId } of ids) {
      const { count } = await supabase
        .from('document_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('document_id', documentId)
      if ((count ?? 0) > 0) continue

      const { data: textRow, error: textError } = await supabase
        .from('document_texts')
        .select('body_text')
        .eq('document_id', documentId)
        .maybeSingle()
      if (textError) throw textError
      if (!textRow?.body_text) continue

      const chunks = chunkText(textRow.body_text)
      console.log(`  [embed] inserting chunks for ${documentId} — ${chunks.length} chunks`)

      // Insert in DB_WRITE_BATCH-sized batches without embedding (no HNSW cost)
      for (let i = 0; i < chunks.length; i += DB_WRITE_BATCH) {
        const rows = chunks.slice(i, i + DB_WRITE_BATCH).map((text, idx) => ({
          document_id: documentId,
          chunk_index: i + idx,
          text,
        }))
        const { error: insertError } = await supabase
          .from('document_chunks')
          .upsert(rows, { onConflict: 'document_id,chunk_index', ignoreDuplicates: true })
        if (insertError) throw insertError
      }
    }

    if (ids.length < PAGE) break
    offset += PAGE
  }

  // Phase 2: Embed all chunks that have no embedding yet, updating one row at a time.
  // Matches the manifesto pattern — each UPDATE touches one HNSW node, always fast.
  console.log('[embed] document_chunks — phase 2: embedding unembedded chunks...')
  while (true) {
    const { data, error } = await supabase
      .from('document_chunks')
      .select('id, text')
      .is('embedding', null)
      .limit(BATCH_SIZE)

    if (error) throw error
    if (!data || data.length === 0) break

    console.log(`  [embed] document_chunks batch count=${data.length}`)
    const embeddings = await embedTexts(data.map(r => r.text), 'document')

    for (let i = 0; i < data.length; i++) {
      const { error: updateError } = await supabase
        .from('document_chunks')
        .update({ embedding: embeddings[i] as unknown as string })
        .eq('id', data[i]!.id)
      if (updateError) throw updateError
    }

    await sleep(INTER_BATCH_SLEEP)
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

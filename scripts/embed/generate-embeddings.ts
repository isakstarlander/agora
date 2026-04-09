import { VoyageAIClient, type EmbedResponseDataItem } from 'voyageai'
import { getSupabaseClient, sleep } from '../ingest/utils.js'

// Single source of truth for embedding dimensions.
// Must match the vector(N) column definition in the DB migrations.
const EMBEDDING_MODEL = 'voyage-4-lite'
const EMBEDDING_DIM   = 1024
const BATCH_SIZE      = 20   // voyage-4-lite supports up to 128 inputs per call
const CHUNK_SIZE      = 500  // characters per document chunk
const CHUNK_OVERLAP   = 100

const voyage   = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY! })
const supabase = getSupabaseClient()

async function embedTexts(texts: string[], inputType: 'document' | 'query'): Promise<number[][]> {
  const response = await voyage.embed({
    input:           texts,
    model:           EMBEDDING_MODEL,
    inputType,
    outputDimension: EMBEDDING_DIM,
  })
  return response.data!.map((d: EmbedResponseDataItem) => d.embedding!)
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
    await sleep(300)
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
        await sleep(300)
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

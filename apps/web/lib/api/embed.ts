import { VoyageAIClient } from 'voyageai'
import { env } from '@/lib/env'

let client: VoyageAIClient | null = null

function getClient(): VoyageAIClient {
  if (!client) client = new VoyageAIClient({ apiKey: env.VOYAGE_API_KEY })
  return client
}

const EMBED_MODEL = 'voyage-4-lite'
const EMBED_DIM   = 1024

export async function embedQuery(text: string): Promise<number[]> {
  const res = await getClient().embed({
    model:           EMBED_MODEL,
    input:           [text],
    outputDimension: EMBED_DIM,
  })
  return res.data![0]!.embedding!
}

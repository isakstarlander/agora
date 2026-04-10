import { createRequire } from 'node:module'
import { env } from '@/lib/env'

// voyageai ships a broken ESM build that neither Turbopack nor Node.js ESM can resolve.
// Import via CJS to force the working CJS entrypoint instead.
const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { VoyageAIClient } = require('voyageai') as typeof import('voyageai')

const EMBED_MODEL = 'voyage-4-lite'
const EMBED_DIM   = 1024

let client: InstanceType<typeof VoyageAIClient> | null = null

function getClient(): InstanceType<typeof VoyageAIClient> {
  if (!client) client = new VoyageAIClient({ apiKey: env.VOYAGE_API_KEY })
  return client
}

export async function embedQuery(text: string): Promise<number[]> {
  const res = await getClient().embed({
    model:           EMBED_MODEL,
    input:           [text],
    outputDimension: EMBED_DIM,
  })
  return res.data![0]!.embedding!
}

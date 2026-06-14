import { request } from 'undici'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { gzipSync } from 'zlib'
import pino from 'pino'

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' })
const s3 = new S3Client({})
const RAW_BUCKET = process.env.RAW_BUCKET!

const BASE = 'https://data.riksdagen.se'
const MAX_ATTEMPTS = 5
const RETRY_STATUSES = new Set([429, 502, 503, 504])

let tokens = 4
let lastRefill = Date.now()

function consumeToken(): number {
  const now = Date.now()
  const elapsed = (now - lastRefill) / 1000
  tokens = Math.min(4, tokens + elapsed * 4)
  lastRefill = now
  if (tokens < 1) return Math.ceil((1 - tokens) / 4 * 1000)
  tokens -= 1
  return 0
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

interface FetchDetailEvent {
  dok_id: string
  doktyp: string
  ingested: string
}

export const handler = async (event: FetchDetailEvent): Promise<{ dok_id: string; doktyp: string; ingested: string }> => {
  const { dok_id, doktyp, ingested } = event
  const url = `${BASE}/dokument/${dok_id}.json`
  let backoff = 250

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const waitMs = consumeToken()
    if (waitMs > 0) await sleep(waitMs)

    const { statusCode, headers, body } = await request(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      bodyTimeout: 30_000,
      headersTimeout: 10_000,
    })

    if (RETRY_STATUSES.has(statusCode)) {
      if (attempt === MAX_ATTEMPTS) throw new Error(`HTTP ${statusCode} from ${url} after ${MAX_ATTEMPTS} attempts`)
      const retryAfter = Number(headers['retry-after'])
      const delay = retryAfter > 0 ? retryAfter * 1000 : backoff
      log.warn({ statusCode, attempt, delay, dok_id }, 'fetch-detail rate/error — retrying')
      await sleep(delay)
      backoff = Math.min(backoff * 2, 4_000)
      tokens = 4
      lastRefill = Date.now()
      continue
    }

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`HTTP ${statusCode} from ${url}`)
    }

    const bytes = Buffer.from(await body.arrayBuffer())
    const compressed = gzipSync(bytes)
    const s3Key = `riks/dokument-detail/${dok_id}.json.gz`

    await s3.send(new PutObjectCommand({
      Bucket: RAW_BUCKET,
      Key: s3Key,
      Body: compressed,
      ContentEncoding: 'gzip',
      ContentType: 'application/json',
    }))

    log.info({ dok_id, s3Key }, 'fetch-detail written')
    return { dok_id, doktyp, ingested }
  }

  throw new Error('Unreachable')
}

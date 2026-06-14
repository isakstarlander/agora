import { request } from 'undici'
import { z } from 'zod'
import { log } from './logger'

const BASE = 'https://data.riksdagen.se'
const MAX_ATTEMPTS = 5
const RETRY_STATUSES = new Set([429, 502, 503, 504])

// Token bucket — module-level state; Lambda is single-threaded so this is safe.
let tokens = 4
let lastRefill = Date.now()

function consumeToken(): number {
  const now = Date.now()
  const elapsed = (now - lastRefill) / 1000
  tokens = Math.min(4, tokens + elapsed * 4)
  lastRefill = now
  if (tokens < 1) {
    return Math.ceil((1 - tokens) / 4 * 1000)
  }
  tokens -= 1
  return 0
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function riksGet<T>(
  path: string,
  params: Record<string, string>,
  schema: z.ZodType<T>,
): Promise<T> {
  const qs = new URLSearchParams({ ...params, utformat: 'json' }).toString()
  const url = `${BASE}${path}?${qs}`

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
      log.warn({ statusCode, attempt, delay }, 'riksdagen rate/error — retrying')
      await sleep(delay)
      backoff = Math.min(backoff * 2, 4_000)
      tokens = 4 // reset bucket after waiting
      lastRefill = Date.now()
      continue
    }

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`HTTP ${statusCode} from ${url}`)
    }

    const json = await body.json()
    const result = schema.safeParse(json)
    if (!result.success) {
      log.warn({ issues: result.error.issues, url }, 'riksdagen schema mismatch — using raw data')
      return json as T
    }
    return result.data
  }

  throw new Error('Unreachable')
}

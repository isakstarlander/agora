import { createServiceClient } from '@/lib/supabase/server'
import crypto from 'node:crypto'

export async function logApiRequest(
  endpoint: string,
  params: Record<string, string>,
  durationMs: number,
  statusCode: number,
): Promise<void> {
  try {
    // Hash params to avoid storing any potentially sensitive query values
    const sorted = Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&')
    const paramsHash = crypto
      .createHash('sha256')
      .update(sorted)
      .digest('hex')
      .slice(0, 16) // 16 hex chars is enough for deduplication

    const supabase = await createServiceClient()
    await supabase.from('api_usage_log').insert({
      endpoint,
      params_hash: paramsHash,
      duration_ms: durationMs,
      status_code: statusCode,
    })
  } catch {
    // Never let logging failure surface to the caller
  }
}

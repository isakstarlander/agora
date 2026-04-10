import { NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { hashKey, isWellFormed } from './keys'

export interface ApiKeyContext {
  keyId:        string
  tier:         'free' | 'paid'
  rateLimitRpm: number
}

/**
 * Extract and validate the API key from the Authorization header.
 *
 * Returns:
 *   { ok: true,  ctx: ApiKeyContext }  — valid key, attach ctx to request
 *   { ok: false, status: 401 }        — missing or invalid key
 *   { ok: false, status: 403 }        — key found but revoked (is_active = false)
 */
export async function validateApiKey(
  req: NextRequest,
): Promise<
  | { ok: true;  ctx: ApiKeyContext }
  | { ok: false; status: 401 | 403; message: string }
> {
  const authHeader = req.headers.get('authorization') ?? ''
  const rawKey = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : ''

  if (!rawKey || !isWellFormed(rawKey)) {
    return { ok: false, status: 401, message: 'API key required. Include: Authorization: Bearer agora_...' }
  }

  const keyHash  = hashKey(rawKey)
  const supabase = await createServiceClient()

  const { data, error } = await supabase
    .from('api_keys')
    .select('id, tier, is_active, rate_limit_rpm, request_count')
    .eq('key_hash', keyHash)
    .single()

  if (error || !data) {
    return { ok: false, status: 401, message: 'Invalid API key.' }
  }

  if (!data.is_active) {
    return { ok: false, status: 403, message: 'API key has been revoked.' }
  }

  // Fire-and-forget: update last_used_at and increment request_count
  void supabase
    .from('api_keys')
    .update({
      last_used_at:  new Date().toISOString(),
      request_count: data.request_count + 1,
    })
    .eq('id', data.id)

  return {
    ok:  true,
    ctx: {
      keyId:        data.id,
      tier:         data.tier as 'free' | 'paid',
      rateLimitRpm: data.rate_limit_rpm,
    },
  }
}

/**
 * Require a valid API key or return a 401/403 result.
 * Use in gated route handlers:
 *
 *   const auth = await requireApiKey(req)
 *   if (!auth.ok) return err('UNAUTHORIZED', auth.message, auth.status)
 */
export async function requireApiKey(req: NextRequest) {
  return validateApiKey(req)
}

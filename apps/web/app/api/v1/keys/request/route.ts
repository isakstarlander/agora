import { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiRoute } from '@/lib/api/handler'
import { ok, badRequest } from '@/lib/api/response'
import { createServiceClient } from '@/lib/supabase/server'
import { generateRawKey, hashKey, extractPrefix } from '@/lib/api/keys'

const RequestKeySchema = z.object({
  email:       z.string().email(),
  description: z.string().min(20).max(500),
})

export const POST = apiRoute(async (req: NextRequest) => {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return badRequest('Request body must be JSON.')
  }

  const parsed = RequestKeySchema.safeParse(body)
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? 'Invalid request body.')
  }

  const { email, description } = parsed.data
  const supabase = await createServiceClient()

  // Enforce one active key per email (self-service limit)
  const { count } = await supabase
    .from('api_keys')
    .select('id', { count: 'exact', head: true })
    .eq('email', email)
    .eq('is_active', true)

  if ((count ?? 0) >= 3) {
    return badRequest('This email already has the maximum number of active keys (3). Contact us to request more.')
  }

  const rawKey  = generateRawKey()
  const keyHash = hashKey(rawKey)
  const prefix  = extractPrefix(rawKey)

  const { error } = await supabase.from('api_keys').insert({
    key_prefix:     prefix,
    key_hash:       keyHash,
    email,
    description,
    tier:           'free',
    rate_limit_rpm: 120,
  })

  if (error) {
    console.error('[keys/request]', error)
    // Hash collision is astronomically unlikely but handle gracefully
    return badRequest('Could not create key. Please try again.')
  }

  // Return the raw key ONCE. It will never be retrievable again.
  return ok({
    key:     rawKey,
    prefix,
    tier:    'free',
    message: 'Store this key securely. It will not be shown again.',
    usage:   'Authorization: Bearer ' + rawKey,
    docs:    '/docs',
  })
})

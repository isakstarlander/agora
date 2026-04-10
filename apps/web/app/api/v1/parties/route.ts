import { NextRequest } from 'next/server'
import { apiRoute } from '@/lib/api/handler'
import { ok, err } from '@/lib/api/response'
import { requireApiKey } from '@/lib/api/auth'
import { PARTY_COLORS, PARTY_NAMES } from '@/lib/utils'

const PARTIES = Object.keys(PARTY_NAMES).map(code => ({
  code,
  name:  PARTY_NAMES[code as keyof typeof PARTY_NAMES],
  color: PARTY_COLORS[code] ?? null,
}))

export const GET = apiRoute(async (req: NextRequest) => {
  const auth = await requireApiKey(req)
  if (!auth.ok) return err('UNAUTHORIZED', auth.message, auth.status)
  return ok(PARTIES)
})

import { apiRoute } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { PARTY_COLORS, PARTY_NAMES } from '@/lib/utils'

const PARTIES = Object.keys(PARTY_NAMES).map(code => ({
  code,
  name:  PARTY_NAMES[code as keyof typeof PARTY_NAMES],
  color: PARTY_COLORS[code] ?? null,
}))

export const GET = apiRoute(async () => ok(PARTIES))

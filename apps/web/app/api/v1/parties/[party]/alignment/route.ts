import { NextRequest } from 'next/server'
import { apiRoute } from '@/lib/api/handler'
import { ok, notFound } from '@/lib/api/response'
import { createClient } from '@/lib/supabase/server'
import { PARTY_NAMES } from '@/lib/utils'

// Returns manifesto positions aggregated by Manifesto Project category
// for the most recent available election year.
export const GET = apiRoute(async (_req: NextRequest, ctx) => {
  const party = (await ctx.params).party as string
  if (!PARTY_NAMES[party]) return notFound('Party')

  const supabase = await createClient()

  const { data: manifestos } = await supabase
    .from('manifestos')
    .select('id, election_year')
    .eq('party_code', party)
    .order('election_year', { ascending: false })
    .limit(1)

  if (!manifestos || manifestos.length === 0) {
    return ok({ party, categories: [], note: 'No manifesto data available' })
  }

  const { data: statements } = await supabase
    .from('manifesto_statements')
    .select('category_code, category_name, position')
    .eq('manifesto_id', manifestos[0]!.id)
    .not('category_code', 'is', null)

  if (!statements) return ok({ party, categories: [] })

  const catMap: Record<string, { name: string; positions: number[]; count: number }> = {}
  for (const s of statements) {
    if (!s.category_code || s.position === null) continue
    if (!catMap[s.category_code]) catMap[s.category_code] = { name: s.category_name ?? s.category_code, positions: [], count: 0 }
    catMap[s.category_code]!.positions.push(s.position)
    catMap[s.category_code]!.count++
  }

  const categories = Object.entries(catMap).map(([code, c]) => ({
    category_code:   code,
    category_name:   c.name,
    statement_count: c.count,
    mean_position:   c.positions.length > 0
      ? Math.round((c.positions.reduce((a, b) => a + b, 0) / c.positions.length) * 100) / 100
      : null,
  })).sort((a, b) => b.statement_count - a.statement_count)

  return ok({
    party,
    manifesto_year: manifestos[0]!.election_year,
    categories,
  })
})

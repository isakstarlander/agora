import { NextRequest } from 'next/server'
import { apiRoute } from '@/lib/api/handler'
import { paginated, err } from '@/lib/api/response'
import { parsePagination, paginate } from '@/lib/api/pagination'
import { createClient } from '@/lib/supabase/server'
import { requireApiKey } from '@/lib/api/auth'

export const GET = apiRoute(async (req: NextRequest, ctx) => {
  const auth = await requireApiKey(req)
  if (!auth.ok) return err('UNAUTHORIZED', auth.message, auth.status)

  const party = (await ctx.params).party as string
  const sp        = req.nextUrl.searchParams
  const pg        = parsePagination(sp)
  const { from, to } = paginate(pg)
  const supabase  = await createClient()

  // Aggregate party position per vote
  const { data, count, error } = await supabase
    .from('vote_results')
    .select('vote_id, result, votes ( date, description, outcome )', { count: 'exact' })
    .eq('party', party)
    .order('votes(date)', { ascending: false })
    .range(from, to)

  if (error) throw error

  // Roll up to majority position per vote_id
  const rollup: Record<string, { vote_id: string; date: string | null; description: string | null; outcome: string | null; party_position: string; ja: number; nej: number }> = {}
  for (const r of data ?? []) {
    const vote = r.votes as { date: string; description: string; outcome: string } | null
    if (!rollup[r.vote_id]) {
      rollup[r.vote_id] = { vote_id: r.vote_id, date: vote?.date ?? null, description: vote?.description ?? null, outcome: vote?.outcome ?? null, party_position: '', ja: 0, nej: 0 }
    }
    if (r.result === 'Ja')  rollup[r.vote_id]!.ja++
    if (r.result === 'Nej') rollup[r.vote_id]!.nej++
  }
  for (const v of Object.values(rollup)) {
    v.party_position = v.ja >= v.nej ? 'Ja' : 'Nej'
  }

  return paginated(Object.values(rollup), count ?? 0, pg.page, pg.per_page)
})

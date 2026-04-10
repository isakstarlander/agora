import { NextRequest } from 'next/server'
import { apiRoute } from '@/lib/api/handler'
import { paginated } from '@/lib/api/response'
import { parsePagination, paginate } from '@/lib/api/pagination'
import { createClient } from '@/lib/supabase/server'

export const GET = apiRoute(async (req: NextRequest, ctx) => {
  const id = (await ctx.params).id as string
  const sp     = req.nextUrl.searchParams
  const pg     = parsePagination(sp)
  const { from, to } = paginate(pg)
  const supabase = await createClient()

  const { data, count, error } = await supabase
    .from('vote_results')
    .select('result, votes ( id, date, description, outcome, yes_count, no_count )', { count: 'exact' })
    .eq('member_id', id)
    .order('votes(date)', { ascending: false })
    .range(from, to)

  if (error) throw error
  return paginated(data ?? [], count ?? 0, pg.page, pg.per_page)
})

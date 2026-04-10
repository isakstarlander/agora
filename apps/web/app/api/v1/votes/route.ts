import { NextRequest } from 'next/server'
import { apiRoute } from '@/lib/api/handler'
import { paginated } from '@/lib/api/response'
import { parsePagination, paginate } from '@/lib/api/pagination'
import { createClient } from '@/lib/supabase/server'

export const GET = apiRoute(async (req: NextRequest) => {
  const sp   = req.nextUrl.searchParams
  const pg   = parsePagination(sp)
  const { from, to } = paginate(pg)
  const supabase = await createClient()

  let query = supabase
    .from('votes')
    .select('id, rm, date, description, yes_count, no_count, abstain_count, absent_count, outcome', { count: 'exact' })
    .order('date', { ascending: false })
    .range(from, to)

  const rm = sp.get('rm')
  if (rm) query = query.eq('rm', rm)

  const { data, count, error } = await query
  if (error) throw error
  return paginated(data ?? [], count ?? 0, pg.page, pg.per_page)
})

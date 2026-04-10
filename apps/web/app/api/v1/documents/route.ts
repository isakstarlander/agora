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
    .from('documents')
    .select('id, type, rm, number, title, date, status, committee, source_url', { count: 'exact' })
    .order('date', { ascending: false })
    .range(from, to)

  const type      = sp.get('type')
  const rm        = sp.get('rm')
  const committee = sp.get('committee')
  const party     = sp.get('party')

  if (type)      query = query.eq('type', type)
  if (rm)        query = query.eq('rm', rm)
  if (committee) query = query.eq('committee', committee)

  if (party) {
    const { data: memberIds } = await supabase
      .from('members').select('id').eq('party', party)
    const ids = (memberIds ?? []).map(m => m.id)
    if (ids.length === 0) return paginated([], 0, pg.page, pg.per_page)
    const { data: docIds } = await supabase
      .from('document_authors').select('document_id').in('member_id', ids)
    const dIds = [...new Set((docIds ?? []).map(d => d.document_id))]
    if (dIds.length === 0) return paginated([], 0, pg.page, pg.per_page)
    query = query.in('id', dIds)
  }

  const { data, count, error } = await query
  if (error) throw error
  return paginated(data ?? [], count ?? 0, pg.page, pg.per_page)
})

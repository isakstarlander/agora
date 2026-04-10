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

  const { data: authorships } = await supabase
    .from('document_authors')
    .select('document_id')
    .eq('member_id', id)
    .range(from, to)

  if (!authorships || authorships.length === 0) {
    return paginated([], 0, pg.page, pg.per_page)
  }

  const docIds = authorships.map(a => a.document_id)
  const { data, count, error } = await supabase
    .from('documents')
    .select('id, type, rm, title, date, status, committee, source_url', { count: 'exact' })
    .in('id', docIds)
    .order('date', { ascending: false })

  if (error) throw error
  return paginated(data ?? [], count ?? 0, pg.page, pg.per_page)
})

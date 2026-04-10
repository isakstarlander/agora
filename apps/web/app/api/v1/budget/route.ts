import { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiRoute } from '@/lib/api/handler'
import { paginated, badRequest } from '@/lib/api/response'
import { parsePagination, paginate } from '@/lib/api/pagination'
import { createClient } from '@/lib/supabase/server'

const BudgetQuerySchema = z.object({
  year:                  z.coerce.number().int().min(2000).max(2100).optional(),
  expenditure_area_code: z.string().optional(),
  budget_type:           z.enum(['utfall', 'budget']).optional(),
})

export const GET = apiRoute(async (req: NextRequest) => {
  const sp     = req.nextUrl.searchParams
  const parsed = BudgetQuerySchema.safeParse(Object.fromEntries(sp))
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid params')

  const pg   = parsePagination(sp)
  const { from, to } = paginate(pg)
  const supabase = await createClient()

  let query = supabase
    .from('budget_outcomes')
    .select(
      'year, month, expenditure_area_code, expenditure_area_name, anslag_code, anslag_name, amount_sek, budget_type',
      { count: 'exact' },
    )
    .order('year', { ascending: false })
    .order('month', { ascending: false, nullsFirst: true })
    .range(from, to)

  const { year, expenditure_area_code, budget_type } = parsed.data
  if (year)                  query = query.eq('year', year)
  if (expenditure_area_code) query = query.eq('expenditure_area_code', expenditure_area_code)
  if (budget_type)           query = query.eq('budget_type', budget_type)

  const { data, count, error } = await query
  if (error) throw error
  return paginated(data ?? [], count ?? 0, pg.page, pg.per_page)
})

import { apiRoute } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { createClient } from '@/lib/supabase/server'

export const GET = apiRoute(async () => {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('budget_outcomes')
    .select('expenditure_area_code, expenditure_area_name')
    .not('expenditure_area_name', 'is', null)
    .order('expenditure_area_code')

  if (error) throw error

  const unique = Object.values(
    (data ?? []).reduce<Record<string, { code: string; name: string }>>((acc, row) => {
      if (row.expenditure_area_code && row.expenditure_area_name) {
        acc[row.expenditure_area_code] = { code: row.expenditure_area_code, name: row.expenditure_area_name }
      }
      return acc
    }, {}),
  )

  return ok(unique)
})

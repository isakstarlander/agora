import { NextRequest } from 'next/server'
import { apiRoute } from '@/lib/api/handler'
import { ok, err } from '@/lib/api/response'
import { createClient } from '@/lib/supabase/server'
import { requireApiKey } from '@/lib/api/auth'

export const GET = apiRoute(async (req: NextRequest) => {
  const auth = await requireApiKey(req)
  if (!auth.ok) return err('UNAUTHORIZED', auth.message, auth.status)

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

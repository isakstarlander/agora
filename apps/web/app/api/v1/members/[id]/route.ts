import { NextRequest } from 'next/server'
import { apiRoute } from '@/lib/api/handler'
import { ok, notFound } from '@/lib/api/response'
import { createClient } from '@/lib/supabase/server'

export const GET = apiRoute(async (_req: NextRequest, ctx) => {
  const id = (await ctx.params).id as string
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('members')
    .select('id, first_name, last_name, party, constituency, status, birth_year, gender, image_url, from_date, to_date')
    .eq('id', id)
    .single()

  if (error || !data) return notFound('Member')
  return ok(data)
})

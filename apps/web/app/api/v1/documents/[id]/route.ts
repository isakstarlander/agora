import { NextRequest } from 'next/server'
import { apiRoute } from '@/lib/api/handler'
import { ok, notFound } from '@/lib/api/response'
import { createClient } from '@/lib/supabase/server'

export const GET = apiRoute(async (_req: NextRequest, ctx) => {
  const id = (await ctx.params).id as string
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('documents')
    .select(`
      id, type, rm, number, title, subtitle, status, date,
      committee, source_url, document_url,
      document_texts ( body_text, word_count ),
      document_authors ( member_id, members ( id, first_name, last_name, party ) )
    `)
    .eq('id', id)
    .single()

  if (error || !data) return notFound('Document')
  return ok(data)
})

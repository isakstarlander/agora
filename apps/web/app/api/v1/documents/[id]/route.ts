import { NextRequest } from 'next/server'
import { apiRoute } from '@/lib/api/handler'
import { ok, notFound, err } from '@/lib/api/response'
import { createClient } from '@/lib/supabase/server'
import { requireApiKey } from '@/lib/api/auth'

export const GET = apiRoute(async (req: NextRequest, ctx) => {
  const auth = await requireApiKey(req)
  if (!auth.ok) return err('UNAUTHORIZED', auth.message, auth.status)

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

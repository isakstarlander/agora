import { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiRoute } from '@/lib/api/handler'
import { ok, badRequest, err } from '@/lib/api/response'
import { createClient } from '@/lib/supabase/server'
import { requireApiKey } from '@/lib/api/auth'
import { embedQuery } from '@/lib/api/embed'

const SearchSchema = z.object({
  q:     z.string().min(2).max(200),
  type:  z.string().optional(),
  rm:    z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
})

export const GET = apiRoute(async (req: NextRequest) => {
  const auth = await requireApiKey(req)
  if (!auth.ok) return err('UNAUTHORIZED', auth.message, auth.status)

  const sp     = req.nextUrl.searchParams
  const parsed = SearchSchema.safeParse(Object.fromEntries(sp))
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid params')

  const { q, type, rm, limit } = parsed.data
  const supabase = await createClient()

  const embedding = await embedQuery(q)

  const { data, error } = await supabase.rpc('search_documents', {
    query_text:      q,
    query_embedding: embedding as unknown as string,
    doc_type:        type ?? undefined,
    doc_rm:          rm ?? undefined,
    match_count:     limit,
  })

  if (error) throw error

  return ok(data ?? [], {
    sources: (data ?? []).map((r: { id: string }) => r.id),
  })
})

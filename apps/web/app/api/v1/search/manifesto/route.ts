import { NextRequest } from 'next/server'
import { z } from 'zod'
import { apiRoute } from '@/lib/api/handler'
import { ok, badRequest, err } from '@/lib/api/response'
import { createClient } from '@/lib/supabase/server'
import { requireApiKey } from '@/lib/api/auth'
import { embedQuery } from '@/lib/api/embed'

const ManifestoSearchSchema = z.object({
  q:             z.string().min(2).max(200),
  party:         z.string().optional(),
  election_year: z.coerce.number().int().optional(),
  limit:         z.coerce.number().int().min(1).max(50).default(10),
})

export const GET = apiRoute(async (req: NextRequest) => {
  const auth = await requireApiKey(req)
  if (!auth.ok) return err('UNAUTHORIZED', auth.message, auth.status)

  const sp     = req.nextUrl.searchParams
  const parsed = ManifestoSearchSchema.safeParse(Object.fromEntries(sp))
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid params')

  const { q, party, election_year, limit } = parsed.data
  const supabase = await createClient()

  const embedding = await embedQuery(q)

  // match_manifesto_statements is defined in migration 010 — not yet in generated types
  const { data: rpcData, error } = await (supabase.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: Array<{ id: number; manifesto_id: number; text: string; category_code: string | null; category_name: string | null; position: number | null; statement_index: number | null; similarity: number }> | null; error: unknown }>)
  ('match_manifesto_statements', {
    query_embedding: embedding as unknown as string,
    match_count:     limit * 2,
  })
  if (error) throw error

  let results: Array<{ manifesto_id: number; [key: string]: unknown }> = rpcData ?? []

  // Post-filter by party / election_year if requested
  if (party || election_year) {
    let mQuery = supabase
      .from('manifestos')
      .select('id, party_code, election_year')
    if (party)         mQuery = mQuery.eq('party_code', party)
    if (election_year) mQuery = mQuery.eq('election_year', election_year)
    const { data: manifestos } = await mQuery
    const allowedIds = new Set((manifestos ?? []).map(m => m.id))
    results = results.filter(r => allowedIds.has(r.manifesto_id))
  }

  results = results.slice(0, limit)

  // Enrich with manifesto metadata
  if (results.length > 0) {
    const manifesto_ids = [...new Set(results.map(r => r.manifesto_id))]
    const { data: manifestos } = await supabase
      .from('manifestos')
      .select('id, party_code, party_name, election_year')
      .in('id', manifesto_ids)

    const manifMap = Object.fromEntries((manifestos ?? []).map(m => [m.id, m]))
    results = results.map(r => ({
      ...r,
      manifesto: manifMap[r.manifesto_id] ?? null,
    }))
  }

  return ok(results, {
    sources: results.map(r => `manifesto:${r.manifesto_id}`),
  })
})

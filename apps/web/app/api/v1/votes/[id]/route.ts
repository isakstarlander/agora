import { NextRequest } from 'next/server'
import { apiRoute } from '@/lib/api/handler'
import { ok, notFound } from '@/lib/api/response'
import { createClient } from '@/lib/supabase/server'

export const GET = apiRoute(async (_req: NextRequest, ctx) => {
  const id = (await ctx.params).id as string
  const supabase = await createClient()

  const [{ data: vote, error: vErr }, { data: results, error: rErr }] = await Promise.all([
    supabase
      .from('votes')
      .select('id, rm, date, description, yes_count, no_count, abstain_count, absent_count, outcome, document_id')
      .eq('id', id)
      .single(),
    supabase
      .from('vote_results')
      .select('party, result, member_id')
      .eq('vote_id', id),
  ])

  if (vErr || !vote) return notFound('Vote')
  if (rErr) throw rErr

  // Aggregate results by party
  const byParty: Record<string, { ja: number; nej: number; franvaro: number; avstar: number }> = {}
  for (const r of results ?? []) {
    if (!byParty[r.party]) byParty[r.party] = { ja: 0, nej: 0, franvaro: 0, avstar: 0 }
    if (r.result === 'Ja')          byParty[r.party]!.ja++
    else if (r.result === 'Nej')    byParty[r.party]!.nej++
    else if (r.result === 'Avstår') byParty[r.party]!.avstar++
    else                            byParty[r.party]!.franvaro++
  }

  return ok({ ...vote, results_by_party: byParty })
})

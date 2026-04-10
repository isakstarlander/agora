import { createClient } from '@/lib/supabase/server'

export async function getPartyVotesOnDocuments(
  party: string,
  documentIds: string[],
): Promise<{
  vote_id:        string
  description:    string | null
  date:           string | null
  outcome:        string | null
  party_position: 'Ja' | 'Nej' | 'split'
  ja_count:       number
  nej_count:      number
}[]> {
  if (documentIds.length === 0) return []
  const supabase = await createClient()

  const { data: votes } = await supabase
    .from('votes')
    .select('id, description, date, outcome, document_id')
    .in('document_id', documentIds)
    .order('date', { ascending: false })
    .limit(20)

  if (!votes || votes.length === 0) return []

  const voteIds = votes.map(v => v.id)
  const { data: results } = await supabase
    .from('vote_results')
    .select('vote_id, result')
    .eq('party', party)
    .in('vote_id', voteIds)

  const tally: Record<string, { ja: number; nej: number }> = {}
  for (const r of results ?? []) {
    if (!tally[r.vote_id]) tally[r.vote_id] = { ja: 0, nej: 0 }
    if (r.result === 'Ja')  tally[r.vote_id]!.ja++
    if (r.result === 'Nej') tally[r.vote_id]!.nej++
  }

  return votes.map(v => {
    const t = tally[v.id] ?? { ja: 0, nej: 0 }
    const position: 'Ja' | 'Nej' | 'split' =
      t.ja > t.nej ? 'Ja' : t.nej > t.ja ? 'Nej' : 'split'
    return {
      vote_id:        v.id,
      description:    v.description,
      date:           v.date,
      outcome:        v.outcome,
      party_position: position,
      ja_count:       t.ja,
      nej_count:      t.nej,
    }
  })
}

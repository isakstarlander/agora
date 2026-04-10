import { NextRequest } from 'next/server'
import { z } from 'zod'
import Anthropic from '@anthropic-ai/sdk'
import { apiRoute } from '@/lib/api/handler'
import { ok, badRequest, err } from '@/lib/api/response'
import { createClient } from '@/lib/supabase/server'
import { embedQuery } from '@/lib/api/embed'
import { classifyTopic } from '@/lib/api/classify'
import { getPartyVotesOnDocuments } from '@/lib/api/party-votes'
import { requireApiKey } from '@/lib/api/auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { PARTY_NAMES } from '@/lib/utils'

const AccountabilitySchema = z.object({
  party: z.string().min(1).max(4),
  topic: z.string().min(3).max(200),
})

const anthropic = new Anthropic()

export const GET = apiRoute(async (req: NextRequest) => {
  // ── Authentication: API key required ──────────────────────────────────────
  const auth = await requireApiKey(req)
  if (!auth.ok) return err('UNAUTHORIZED', auth.message, auth.status)

  // ── Rate limiting: keyed by API key ID, tier-aware ──────────────────────
  const { allowed, retryAfter } = await checkRateLimit(
    req, 'account', auth.ctx.keyId, auth.ctx.tier,
  )
  if (!allowed) return err('RATE_LIMITED', `Försök igen om ${retryAfter} sekunder.`, 429)

  // ── Input validation ──────────────────────────────────────────────────────
  const sp     = req.nextUrl.searchParams
  const parsed = AccountabilitySchema.safeParse(Object.fromEntries(sp))
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid params')

  const { party, topic } = parsed.data

  if (!PARTY_NAMES[party]) return badRequest(`Unknown party code: ${party}`)

  const supabase = await createClient()

  // ── Run all data-fetching concurrently ────────────────────────────────────

  const [embedding, areaCodes] = await Promise.all([
    embedQuery(topic),
    classifyTopic(topic),
  ])

  const [manifestoRes, documentRes, budgetRes] = await Promise.all([
    // Layer 1 — Promises: semantic search of manifesto statements
    supabase.rpc('match_manifesto_statements', {
      query_embedding: embedding as unknown as string,
      match_count:     20,
    }).then(async ({ data }) => {
      if (!data) return []
      // Filter to this party
      const manifesto_ids = [...new Set(data.map((r: { manifesto_id: number }) => r.manifesto_id))]
      const { data: manifestos } = await supabase
        .from('manifestos')
        .select('id, party_code, election_year')
        .in('id', manifesto_ids)
        .eq('party_code', party)
      const partyAllowed = new Set((manifestos ?? []).map(m => m.id))
      const yearMap      = Object.fromEntries((manifestos ?? []).map(m => [m.id, m.election_year]))
      return data
        .filter((r: { manifesto_id: number }) => partyAllowed.has(r.manifesto_id))
        .slice(0, 5)
        .map((r: { text: string; category_name: string; manifesto_id: number; similarity: number }) => ({
          text:          r.text,
          category_name: r.category_name,
          election_year: yearMap[r.manifesto_id] ?? null,
          similarity:    Math.round(r.similarity * 100) / 100,
        }))
    }),

    // Layer 2 — Legislation: hybrid search for documents by this party
    supabase.rpc('search_documents', {
      query_text:      topic,
      query_embedding: embedding as unknown as string,
      doc_type:        undefined,
      doc_rm:          undefined,
      match_count:     20,
    }).then(async ({ data }) => {
      if (!data) return []
      const docIds = data.map((r: { id: string }) => r.id)
      // Filter to documents authored by this party's members
      const { data: memberIds } = await supabase
        .from('members').select('id').eq('party', party)
      const mIds = (memberIds ?? []).map(m => m.id)
      const { data: authorships } = await supabase
        .from('document_authors').select('document_id').in('member_id', mIds).in('document_id', docIds)
      const partyDocIds = new Set((authorships ?? []).map(a => a.document_id))
      return data
        .filter((r: { id: string }) => partyDocIds.has(r.id))
        .slice(0, 5)
        .map((r: { id: string; title: string; type: string; date: string; rm: string; source_url: string; fts_rank: number; vec_rank: number }) => ({
          id:         r.id,
          type:       r.type,
          title:      r.title,
          date:       r.date,
          rm:         r.rm,
          source_url: r.source_url,
          relevance:  Math.round((r.fts_rank * 0.4 + r.vec_rank * 0.6) * 1000) / 1000,
        }))
    }),

    // Layer 4 — Budget: spending trend for relevant expenditure areas
    areaCodes.length > 0
      ? supabase
          .from('budget_outcomes')
          .select('expenditure_area_code, expenditure_area_name, year, amount_sek, budget_type')
          .in('expenditure_area_code', areaCodes)
          .is('month', null) // annual totals only
          .order('year', { ascending: false })
          .limit(areaCodes.length * 8) // 4 years × 2 types × n areas
          .then(({ data }) => {
            if (!data) return []
            type Row = {
              expenditure_area_code: string
              expenditure_area_name: string | null
              year:       number
              utfall_sek: number | null
              budget_sek: number | null
              delta_pct:  number | null
            }
            const map: Record<string, Row> = {}
            for (const row of data) {
              const key = `${row.expenditure_area_code}:${row.year}`
              if (!map[key]) map[key] = {
                expenditure_area_code: row.expenditure_area_code,
                expenditure_area_name: row.expenditure_area_name,
                year:       row.year,
                utfall_sek: null,
                budget_sek: null,
                delta_pct:  null,
              }
              const amt = row.amount_sek ? Number(row.amount_sek) : null
              if (row.budget_type === 'utfall') map[key]!.utfall_sek = amt
              if (row.budget_type === 'budget') map[key]!.budget_sek = amt
            }
            const rows = Object.values(map).sort(
              (a, b) => b.year - a.year || a.expenditure_area_code.localeCompare(b.expenditure_area_code),
            )
            return rows.map(r => ({
              ...r,
              delta_pct:
                r.utfall_sek !== null && r.budget_sek !== null && r.budget_sek !== 0
                  ? Math.round(((r.utfall_sek - r.budget_sek) / Math.abs(r.budget_sek)) * 1000) / 10
                  : null,
            }))
          })
      : Promise.resolve([]),
  ])

  // Layer 3 — Votes: get party votes on the legislation found in Layer 2
  const legislationDocIds = (documentRes as { id: string }[]).map(d => d.id)
  const votesRes = await getPartyVotesOnDocuments(party, legislationDocIds)

  // ── Compile sources ───────────────────────────────────────────────────────
  const sources: string[] = [
    ...(manifestoRes as { election_year: number }[]).map(r => `manifesto:${party}:${r.election_year}`),
    ...(documentRes as { id: string }[]).map(r => `riksdagen:${r.id}`),
    ...votesRes.map(r => `vote:${r.vote_id}`),
    ...areaCodes.map(c => `esv:area:${c}`),
  ]

  // ── AI synthesis ──────────────────────────────────────────────────────────
  let summary: string | null = null
  try {
    const partyName = PARTY_NAMES[party] ?? party
    const context = [
      manifestoRes.length > 0
        ? `VALLÖFTEN (${partyName}, ${(manifestoRes as { election_year: number }[])[0]?.election_year}):\n${(manifestoRes as { text: string }[]).map(r => `- ${r.text}`).join('\n')}`
        : null,
      documentRes.length > 0
        ? `LAGSTIFTNING:\n${(documentRes as { title: string; type: string; rm: string }[]).map(r => `- [${r.type}] ${r.title} (${r.rm})`).join('\n')}`
        : null,
      votesRes.length > 0
        ? `VOTERINGAR:\n${votesRes.map(v => `- ${v.description ?? v.vote_id}: ${partyName} röstade ${v.party_position} (${v.ja_count} Ja, ${v.nej_count} Nej)`).join('\n')}`
        : null,
      (budgetRes as { expenditure_area_name: string | null; year: number; utfall_sek: number | null }[]).length > 0
        ? `BUDGET (faktiskt utfall):\n${(budgetRes as { expenditure_area_name: string | null; year: number; utfall_sek: number | null }[]).slice(0, 6).map(r => `- ${r.expenditure_area_name ?? r.year}: ${r.utfall_sek !== null ? (r.utfall_sek / 1e9).toFixed(1) + ' miljarder SEK' : 'okänt'} (${r.year})`).join('\n')}`
        : null,
    ].filter(Boolean).join('\n\n')

    if (context.length > 50) {
      const msg = await anthropic.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 250,
        messages: [
          {
            role: 'user',
            content: `Du är en opartisk politisk analytiker. Sammanfatta på svenska (max 150 ord) hur väl ${partyName} har hållit sina löften om "${topic}" baserat på följande data. Var faktabaserad och neutral. Inkludera inga egna värderingar.

${context}`,
          },
        ],
      })
      summary = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : null
    }
  } catch (e) {
    console.error('[accountability] synthesis failed', e)
    // summary stays null — structured data still returned
  }

  return ok(
    {
      party,
      topic,
      layers: {
        promises:    manifestoRes,
        legislation: documentRes,
        votes:       votesRes,
        budget:      budgetRes,
      },
      summary,
      sources,
    },
    { sources, generated_at: new Date().toISOString() },
  )
})

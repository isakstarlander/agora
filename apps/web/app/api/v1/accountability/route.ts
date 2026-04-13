import { NextRequest } from 'next/server'
import { createHash } from 'crypto'
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

// Normalise a topic string to a stable cache key.
function topicHash(topic: string): string {
  return createHash('sha256')
    .update(topic.toLowerCase().trim())
    .digest('hex')
}

const SUMMARY_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

// The static synthesis instructions — marked for prompt caching.
const SYNTHESIS_SYSTEM = `Du är en opartisk politisk analytiker. När du får strukturerad data om ett partis politiska aktivitet ska du sammanfatta på svenska (max 150 ord) hur väl partiet har hållit sina löften om det angivna ämnet. Var faktabaserad och neutral. Inkludera inga egna värderingar. Om data saknas för ett lager, notera det kort.`

export const GET = apiRoute(async (req: NextRequest) => {
  // ── Authentication ─────────────────────────────────────────────────────────
  const auth = await requireApiKey(req)
  if (!auth.ok) return err('UNAUTHORIZED', auth.message, auth.status)

  // ── Rate limiting ──────────────────────────────────────────────────────────
  const { allowed, retryAfter } = await checkRateLimit(
    req, 'account', auth.ctx.keyId, auth.ctx.tier,
  )
  if (!allowed) return err('RATE_LIMITED', `Försök igen om ${retryAfter} sekunder.`, 429)

  // ── Input validation ───────────────────────────────────────────────────────
  const sp     = req.nextUrl.searchParams
  const parsed = AccountabilitySchema.safeParse(Object.fromEntries(sp))
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid params')

  const { party, topic } = parsed.data
  if (!PARTY_NAMES[party]) return badRequest(`Unknown party code: ${party}`)

  const supabase    = await createClient()
  const isPaidTier  = auth.ctx.tier === 'paid'
  const hash        = topicHash(topic)

  // ── Check summary cache (paid tier only — free tier skips this) ────────────
  let cachedSummary: string | null | undefined = undefined // undefined = not checked
  if (isPaidTier) {
    const { data: cacheRow } = await supabase
      .from('accountability_cache')
      .select('summary, generated_at')
      .eq('party', party)
      .eq('topic_hash', hash)
      .single()

    if (cacheRow) {
      const age = Date.now() - new Date(cacheRow.generated_at).getTime()
      if (age < SUMMARY_TTL_MS) {
        cachedSummary = cacheRow.summary // may be null (synthesis returned nothing)
      }
    }
  }

  // ── Fetch all data layers concurrently ────────────────────────────────────
  const [embedding, areaCodes] = await Promise.all([
    embedQuery(topic),
    classifyTopic(topic),
  ])

  const [manifestoRes, documentRes, budgetRes] = await Promise.all([
    // Layer 1 — Promises: semantic search with similarity floor
    supabase.rpc('match_manifesto_statements', {
      query_embedding: embedding as unknown as string,
      match_count:     20,
    }).then(async ({ data }) => {
      if (!data) return []
      const manifesto_ids = [...new Set(data.map((r: { manifesto_id: number }) => r.manifesto_id))]
      const { data: manifestos } = await supabase
        .from('manifestos')
        .select('id, party_code, election_year')
        .in('id', manifesto_ids)
        .eq('party_code', party)
      const allowed  = new Set((manifestos ?? []).map(m => m.id))
      const yearMap  = Object.fromEntries((manifestos ?? []).map(m => [m.id, m.election_year]))
      return data
        .filter((r: { manifesto_id: number; similarity: number }) =>
          allowed.has(r.manifesto_id) && r.similarity >= 0.5,  // ← similarity floor
        )
        .slice(0, 5)
        .map((r: { text: string; category_name: string; manifesto_id: number; similarity: number }) => ({
          text:          r.text,
          category_name: r.category_name,
          election_year: yearMap[r.manifesto_id] ?? null,
          similarity:    Math.round(r.similarity * 100) / 100,
        }))
    }),

    // Layer 2 — Legislation: top relevant documents regardless of author.
    // Accountability is about what parliament debated and how the party voted,
    // not about which documents the party authored.
    supabase.rpc('search_documents', {
      query_text:      topic,
      query_embedding: embedding as unknown as string,
      doc_type:        undefined,
      doc_rm:          undefined,
      match_count:     20,
    }).then(({ data }) => {
      if (!data) return []
      return (data as {
        id: string; title: string; type: string; date: string
        rm: string; source_url: string; fts_rank: number; vec_rank: number
      }[])
        .slice(0, 5)
        .map(r => ({
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
          .is('month', null)
          .order('year', { ascending: false })
          .limit(areaCodes.length * 8)
          .then(({ data }) => {
            if (!data) return []
            type Row = {
              expenditure_area_code: string; expenditure_area_name: string | null
              year: number; utfall_sek: number | null; budget_sek: number | null; delta_pct: number | null
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
              delta_pct: r.utfall_sek !== null && r.budget_sek !== null && r.budget_sek !== 0
                ? Math.round(((r.utfall_sek - r.budget_sek) / Math.abs(r.budget_sek)) * 1000) / 10
                : null,
            }))
          })
      : Promise.resolve([]),
  ])

  // Layer 3 — Votes: party's voting record on the documents found in Layer 2.
  // Now that Layer 2 returns all topically relevant documents (not just party-authored
  // ones), this layer will surface votes on the actual legislation being debated.
  const legislationDocIds = (documentRes as { id: string }[]).map(d => d.id)
  const votesRes = await getPartyVotesOnDocuments(party, legislationDocIds)

  // ── Compile sources ────────────────────────────────────────────────────────
  const sources: string[] = [
    ...(manifestoRes as { election_year: number }[]).map(r => `manifesto:${party}:${r.election_year}`),
    ...(documentRes as { id: string }[]).map(r => `riksdagen:${r.id}`),
    ...votesRes.map(r => `vote:${r.vote_id}`),
    ...areaCodes.map(c => `esv:area:${c}`),
  ]

  // ── AI synthesis (paid tier only) ──────────────────────────────────────────
  let summary: string | null = null

  if (!isPaidTier) {
    // Free tier: structured data only, no synthesis.
    summary = null
  } else if (cachedSummary !== undefined) {
    // Cache hit — use stored result without calling Claude.
    summary = cachedSummary
  } else {
    // Cache miss — generate and persist.
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
          system: [
            {
              type: 'text',
              text: SYNTHESIS_SYSTEM,
              // Prompt caching on the static system prefix.
              // Reduces input token cost ~90% for repeated (party, topic) queries
              // that share the same instruction text.
              cache_control: { type: 'ephemeral' },
            } as Anthropic.TextBlockParam & { cache_control: { type: 'ephemeral' } },
          ],
          messages: [
            {
              role: 'user',
              content: `Parti: ${partyName}\nÄmne: "${topic}"\n\n${context}`,
            },
          ],
        })
        summary = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : null
      }
    } catch (e) {
      console.error('[accountability] synthesis failed', e)
      // summary stays null — structured data still returned
    }

    // Persist to cache (even if summary is null — avoids retrying a failed synthesis).
    try {
      await supabase.from('accountability_cache').upsert(
        { party, topic_hash: hash, topic_raw: topic, summary, generated_at: new Date().toISOString() },
        { onConflict: 'party,topic_hash' },
      )
    } catch (e) {
      console.error('[accountability] cache write failed', e)
      // Non-fatal — response is unaffected.
    }
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

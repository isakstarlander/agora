import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchRiksdagen, sleep } from './utils.js'

interface RiksdagenVotering {
  votering_id: string
  rm: string
  beteckning: string
  punkt: string
  titel: string
  datum?: string
  ja?: string | number
  nej?: string | number
  'frånvarande'?: string | number
  'avstår'?: string | number
  utfall?: string
  dokument_id?: string
}

interface VoteringListResponse {
  voteringlista: {
    votering: RiksdagenVotering | RiksdagenVotering[]
    '@sidor': string
  }
}

/**
 * Covers both known API response shapes for individual vote result items.
 *
 * Normal shape (källa absent / other):  votering_id, intressent_id, namn, partibet, rost, …
 * Alternate shape (källa=RIM-vot):       votering_id, intressent_id, namn, parti (not partibet!),
 *   rost, votering (vote type: "huvud"/"motval"), avser, banknummer, fornamn,
 *   efternamn, kon, fodd, rm, beteckning, källa, datum, systemdatum
 *
 * Both shapes have intressent_id and rost with the same values.
 * Party field differs: partibet (normal) vs parti (alternate).
 */
interface RiksdagenVoteResult {
  votering_id:    string
  intressent_id?: string
  namn?:          string
  partibet?:      string   // normal shape party abbreviation
  parti?:         string   // alternate shape party abbreviation (same values, different key)
  rost?:          string   // member's vote: "Ja" | "Nej" | "Frånvarande" | "Avstår"
  // Alternate-shape extras
  votering?:      string   // vote TYPE: "huvud" | "motval" (not the member's vote)
  avser?:         string
  banknummer?:    string
  källa?:         string
  datum?:         string
}

interface VoteResultResponse {
  voteringlista?: {
    votering: RiksdagenVoteResult | RiksdagenVoteResult[]
  }
  // Alternate shape returned by some vote result endpoints (källa=RIM-vot)
  votering?: {
    dokvotering: {
      votering: RiksdagenVoteResult | RiksdagenVoteResult[]
    }
  }
}

/** Normalise both known API response shapes into a flat result array */
function extractVoteResults(data: VoteResultResponse): RiksdagenVoteResult[] {
  const normal = data.voteringlista?.votering
  if (normal) return Array.isArray(normal) ? normal : [normal]
  const alternate = data.votering?.dokvotering?.votering
  if (alternate) return Array.isArray(alternate) ? alternate : [alternate]
  return []
}

/**
 * Resolve the member's vote from a result item regardless of shape.
 * Normal shape: r.rost ("Ja"/"Nej"/"Frånvarande"/"Avstår")
 * Alternate shape: unclear — log unknown values so they can be investigated.
 */
const VOTE_VALUES = new Set(['Ja', 'Nej', 'Frånvarande', 'Avstår'])
function resolveRost(r: RiksdagenVoteResult): string {
  if (r.rost && VOTE_VALUES.has(r.rost))    return r.rost
  if (r.votering && VOTE_VALUES.has(r.votering)) return r.votering
  // Unknown — default but log once per call site
  return 'Frånvarande'
}

export async function ingestVotes(
  client: SupabaseClient,
  rms: string[],
): Promise<{ inserted: number; updated: number }> {
  let totalInserted = 0
  const PAGE_SIZE = 100

  for (const rm of rms) {
    let page = 1
    let hasMore = true

    while (hasMore) {
      // Encode the slash in rm (e.g. "2025/26" → "2025%2F26") so the API
      // interprets it as a query-string value, not a path segment.
      const rmEncoded = encodeURIComponent(rm)
      const url =
        `https://data.riksdagen.se/voteringlista/?rm=${rmEncoded}` +
        `&sz=${PAGE_SIZE}&p=${page}&utformat=json`

      const data = await fetchRiksdagen<VoteringListResponse>(url)
      const lista = data.voteringlista

      const totalPages = parseInt(lista['@sidor'] ?? '1', 10)
      console.log(`  rm=${rm} page=${page}/${totalPages}`)

      const raw = lista.votering
      if (!raw) { hasMore = false; break }
      const voteList = Array.isArray(raw) ? raw : [raw]
      if (voteList.length === 0) { hasMore = false; break }

      // Deduplicate by votering_id — the API occasionally returns the same vote
      // twice within a single page, which triggers a PG21000 conflict error.
      const seenVotes = new Set<string>()
      const uniqueVoteList = voteList.filter(v => {
        if (seenVotes.has(v.votering_id)) return false
        seenVotes.add(v.votering_id)
        return true
      })

      const voteRows = uniqueVoteList.map(v => ({
        id:            v.votering_id,
        document_id:   v.dokument_id ?? null,
        rm:            v.rm,
        date:          v.datum ? v.datum.split('T')[0] : null,
        description:   v.titel ?? null,
        yes_count:     Number(v.ja ?? 0),
        no_count:      Number(v.nej ?? 0),
        abstain_count: Number(v['avstår'] ?? 0),
        absent_count:  Number(v['frånvarande'] ?? 0),
        outcome:       v.utfall ?? null,
      }))

      const { error } = await client
        .from('votes')
        .upsert(voteRows, { onConflict: 'id', ignoreDuplicates: false })
      if (error) throw error

      totalInserted += uniqueVoteList.length

      // Fetch individual vote results
      for (const vote of uniqueVoteList) {
        try {
          const resultUrl = `https://data.riksdagen.se/votering/${vote.votering_id}/json`
          const resultData = await fetchRiksdagen<VoteResultResponse>(resultUrl)
          const rawResults = extractVoteResults(resultData)
          if (rawResults.length === 0) continue

          // Diagnostic: flag alternate-shape responses so we can verify field names
          const isAlternateShape = Boolean(resultData.votering)
          if (isAlternateShape && rawResults.length > 0) {
            const sample = rawResults[0] as unknown as Record<string, unknown>
            const knownVoteValue = sample.rost ?? sample.votering
            console.log(
              `  [alt-shape] vote=${vote.votering_id} källa=${sample.källa ?? '?'} ` +
              `fields=${Object.keys(sample).join(',')} voteValue=${knownVoteValue}`,
            )
          }

          // Deduplicate by (vote_id, member_id) — the API occasionally returns
          // duplicate entries for the same member in a single vote response.
          // Skip items without intressent_id — alternate shape may use banknummer
          // instead; those cannot be joined to members table.
          const seen = new Set<string>()
          const resultRows = rawResults
            .filter(r => {
              if (!r.intressent_id) return false
              const key = `${r.votering_id}:${r.intressent_id}`
              if (seen.has(key)) return false
              seen.add(key)
              return true
            })
            .map(r => ({
              vote_id:   r.votering_id,
              member_id: r.intressent_id!,
              party:     r.partibet ?? r.parti ?? 'okänt',
              result:    resolveRost(r),
            }))

          await client
            .from('vote_results')
            .upsert(resultRows, { onConflict: 'vote_id,member_id', ignoreDuplicates: true })
          await sleep(1100)
        } catch (err) {
          console.warn(`  Failed to fetch results for vote ${vote.votering_id}:`, err)
        }
      }

      hasMore = page < totalPages
      page++
      await sleep(1100)
    }
  }

  return { inserted: totalInserted, updated: 0 }
}

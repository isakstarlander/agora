import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchRiksdagen, sleep } from './utils.js'

/** Run `fn` over `items` with at most `concurrency` simultaneous executions. */
async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const iter = items[Symbol.iterator]()
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let next = iter.next(); !next.done; next = iter.next()) {
        await fn(next.value)
      }
    }),
  )
}

/**
 * One row returned by voteringlista with gruppering=votering_id.
 *
 * Note: the API returns capitalised field names for vote counts (Ja, Nej, …).
 * Pagination (p=) is ignored by this endpoint — all unique votes for the rm
 * are returned in a single response. Use sz large enough to cover the full year
 * (empirically: ≤ ~700 unique votes per riksår, so 10 000 is safe).
 */
interface RiksdagenVoteSummary {
  votering_id: string
  Ja:          string | number
  Nej:         string | number
  Frånvarande: string | number
  Avstår:      string | number
}

interface VoteringListResponse {
  voteringlista: {
    votering: RiksdagenVoteSummary | RiksdagenVoteSummary[]
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
    dokument?: {
      titel?:       string
      datum?:       string
      dok_id?:      string
      beteckning?:  string
    }
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

  for (const rm of rms) {
    // The voteringlista API with gruppering=votering_id returns one row per
    // unique vote with aggregate counts (Ja, Nej, Frånvarande, Avstår).
    //
    // IMPORTANT API quirks discovered through testing:
    //   1. @sidor is never present — pagination (p=) is completely ignored.
    //   2. All unique votes for the rm are returned in a single response.
    //   3. sz controls how many unique votes are returned; use a large value
    //      to ensure the full year is captured (empirically ≤ ~700/year).
    //   4. Field names for counts are capitalised: Ja, Nej, Frånvarande, Avstår.
    const rmEncoded = encodeURIComponent(rm)
    const url =
      `https://data.riksdagen.se/voteringlista/?rm=${rmEncoded}` +
      `&gruppering=votering_id&sz=10000&utformat=json`

    const data = await fetchRiksdagen<VoteringListResponse>(url)
    const raw = data.voteringlista?.votering
    if (!raw) {
      console.log(`  rm=${rm}: no votes found`)
      continue
    }
    const voteList = Array.isArray(raw) ? raw : [raw]
    console.log(`  rm=${rm}: ${voteList.length} unique votes`)

    // Insert vote rows with aggregate counts.
    // titel, datum, outcome, and document_id are not available from the
    // voteringlista summary — they are enriched below from votering/{id}/json.
    // ignoreDuplicates: true avoids resetting previously-enriched metadata
    // (date, description, document_id) on re-runs, since vote counts don't
    // change after a vote is cast.
    const voteRows = voteList.map(v => ({
      id:            v.votering_id,
      rm,
      yes_count:     Number(v.Ja          ?? 0),
      no_count:      Number(v.Nej         ?? 0),
      abstain_count: Number(v.Avstår      ?? 0),
      absent_count:  Number(v.Frånvarande ?? 0),
    }))

    const { error } = await client
      .from('votes')
      .upsert(voteRows, { onConflict: 'id', ignoreDuplicates: true })
    if (error) throw error

    totalInserted += voteList.length

    // Pre-check which votes already have results — skip those on re-runs.
    // Votes never change after being cast, so existing rows are always complete.
    const voteIds = voteList.map(v => v.votering_id)
    const processedIds = new Set<string>()
    const IN_BATCH = 500
    for (let i = 0; i < voteIds.length; i += IN_BATCH) {
      const { data: existing, error: existingErr } = await client
        .from('vote_results')
        .select('vote_id')
        .in('vote_id', voteIds.slice(i, i + IN_BATCH))
      if (existingErr) throw existingErr
      existing?.forEach(r => processedIds.add(r.vote_id))
    }

    const unprocessed = voteList.filter(v => !processedIds.has(v.votering_id))
    console.log(`  rm=${rm}: ${processedIds.size} votes already processed, ${unprocessed.length} to fetch`)

    // Fetch per-member results with bounded concurrency (4 parallel requests).
    await runConcurrent(unprocessed, 4, async (vote) => {
      try {
        const resultUrl  = `https://data.riksdagen.se/votering/${vote.votering_id}/json`
        const resultData = await fetchRiksdagen<VoteResultResponse>(resultUrl)
        const rawResults = extractVoteResults(resultData)
        if (rawResults.length === 0) return

        const dok = resultData.votering?.dokument
        if (dok) {
          const meta = {
            date:        dok.datum ? dok.datum.split('T')[0].split(' ')[0] : null,
            description: dok.titel ?? null,
            document_id: dok.dok_id ?? null,
          }
          const { error: updateErr } = await client
            .from('votes')
            .update(meta)
            .eq('id', vote.votering_id)
          if (updateErr) {
            if (updateErr.code === '23503') {
              const { error: retryErr } = await client
                .from('votes')
                .update({ date: meta.date, description: meta.description })
                .eq('id', vote.votering_id)
              if (retryErr) console.warn(`  Failed to enrich vote ${vote.votering_id}:`, retryErr.message)
            } else {
              console.warn(`  Failed to enrich vote ${vote.votering_id}:`, updateErr.message)
            }
          }
        }

        const seen       = new Set<string>()
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

        await sleep(200)
      } catch (err) {
        console.warn(`  Failed to fetch results for vote ${vote.votering_id}:`, err)
      }
    })
  }

  return { inserted: totalInserted, updated: 0 }
}

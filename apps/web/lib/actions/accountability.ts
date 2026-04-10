'use server'

const BASE         = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
const INTERNAL_KEY = process.env.AGORA_INTERNAL_API_KEY ?? ''

export interface AccountabilityResult {
  party: string
  topic: string
  layers: {
    promises:    { text: string; category_name: string | null; election_year: number; similarity: number }[]
    legislation: { id: string; type: string; title: string; date: string | null; rm: string; source_url: string | null }[]
    votes:       { vote_id: string; description: string | null; date: string | null; outcome: string | null; party_position: string; ja_count: number; nej_count: number }[]
    budget:      { expenditure_area_code: string; expenditure_area_name: string | null; year: number; utfall_sek: number | null; budget_sek: number | null; delta_pct: number | null }[]
  }
  summary:  string | null
  sources:  string[]
}

export async function fetchAccountability(
  party: string,
  topic: string,
): Promise<{ data: AccountabilityResult | null; error: string | null }> {
  if (!party || !topic || topic.length < 3) {
    return { data: null, error: 'Ange ett ämne (minst 3 tecken) och välj ett parti.' }
  }

  try {
    const url = `${BASE}/api/v1/accountability?party=${encodeURIComponent(party)}&topic=${encodeURIComponent(topic)}`
    const res = await fetch(url, {
      next: { revalidate: 60 },
      headers: {
        // Internal key — server-only, never reaches the browser
        Authorization: `Bearer ${INTERNAL_KEY}`,
      },
    })
    const json = await res.json()

    if (!res.ok) {
      return { data: null, error: json.error?.message ?? 'Något gick fel.' }
    }

    return { data: json.data as AccountabilityResult, error: null }
  } catch {
    return { data: null, error: 'Kunde inte nå API:et. Försök igen.' }
  }
}

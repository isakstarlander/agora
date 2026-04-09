import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchRiksdagen, sleep } from './utils.js'

interface RiksdagenPerson {
  intressent_id: string   // the actual person ID — the API uses intressent_id, not id
  tilltalsnamn: string
  efternamn: string
  parti: string
  valkrets?: string
  status: string
  fodd_ar?: string | number
  kon?: string
  bild_url_192?: string
  from?: string
  tom?: string
}

interface PersonListResponse {
  personlista: {
    person: RiksdagenPerson | RiksdagenPerson[]
  }
}

export async function ingestMembers(
  client: SupabaseClient,
): Promise<{ inserted: number; updated: number }> {
  const url = 'https://data.riksdagen.se/personlista/?utformat=json&rdlstatus=samtliga'
  const data = await fetchRiksdagen<PersonListResponse>(url)

  const persons = data.personlista.person
  const list = Array.isArray(persons) ? persons : [persons]

  let updated = 0
  const BATCH_SIZE = 50

  // The Riksdagen API uses intressent_id (not id) as the person identifier.
  // Filter records where this field is absent (should not occur, but guard defensively).
  const validList = list.filter(p => p.intressent_id && p.intressent_id.trim() !== '')
  const skipped = list.length - validList.length
  if (skipped > 0) console.log(`Members: skipping ${skipped} records with no intressent_id`)

  for (let i = 0; i < validList.length; i += BATCH_SIZE) {
    const batch = validList.slice(i, i + BATCH_SIZE).map(p => ({
      id:           p.intressent_id,
      first_name:   p.tilltalsnamn ?? '',
      last_name:    p.efternamn ?? '',
      party:        p.parti ?? 'okänt',
      constituency: p.valkrets ?? null,
      status:       p.status === 'Tjänstgörande riksdagsledamot' ? 'active' : 'inactive',
      birth_year:   p.fodd_ar ? Number(p.fodd_ar) : null,
      gender:       p.kon ?? null,
      image_url:    p.bild_url_192 ?? null,
      from_date:    p.from ?? null,
      to_date:      p.tom ?? null,
      updated_at:   new Date().toISOString(),
    }))

    const { error } = await client
      .from('members')
      .upsert(batch, { onConflict: 'id', ignoreDuplicates: false })

    if (error) throw error
    updated += batch.length
    await sleep(200)
  }

  console.log(`Members: inserted/updated ${updated}`)
  return { inserted: 0, updated }
}

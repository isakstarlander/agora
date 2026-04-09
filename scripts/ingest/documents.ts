import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchRiksdagen, sleep } from './utils.js'

const DOCUMENT_TYPES = ['mot', 'prop', 'bet', 'ip', 'fr'] as const
const PAGE_SIZE = 100

interface RiksdagenIntressent {
  intressent_id: string
  namn: string
  partibet: string
  ordning: string
  roll: string
}

interface RiksdagenDokument {
  id: string
  typ: string
  rm: string
  beteckning?: string
  titel: string
  undertitel?: string
  status?: string
  datum?: string
  organ?: string
  dokument_url_html?: string
  relaterat_id?: string
  intressent?: { intressent: RiksdagenIntressent | RiksdagenIntressent[] }
}

interface DokumentListaResponse {
  dokumentlista: {
    dokument: RiksdagenDokument | RiksdagenDokument[]
    '@sidor': string
    '@sida': string
    '@traffar': string
  }
}

export async function ingestDocuments(
  client: SupabaseClient,
  rms: string[],
): Promise<{ inserted: number; updated: number }> {
  let totalInserted = 0

  for (const rm of rms) {
    for (const typ of DOCUMENT_TYPES) {
      console.log(`  Ingesting ${typ} for ${rm}...`)
      let page = 1
      let hasMore = true

      while (hasMore) {
        const url =
          `https://data.riksdagen.se/dokumentlista/?rm=${rm}&typ=${typ}` +
          `&sz=${PAGE_SIZE}&p=${page}&utformat=json`

        const data = await fetchRiksdagen<DokumentListaResponse>(url)
        const lista = data.dokumentlista

        const rawDocs = lista.dokument
        if (!rawDocs) { hasMore = false; break }
        const docs = Array.isArray(rawDocs) ? rawDocs : [rawDocs]
        if (docs.length === 0) { hasMore = false; break }

        const docRows = docs.map(d => ({
          id:           d.id,
          type:         d.typ,
          rm:           d.rm,
          number:       d.beteckning ?? null,
          title:        d.titel ?? '',
          subtitle:     d.undertitel ?? null,
          status:       d.status ?? null,
          date:         d.datum ? d.datum.split('T')[0] : null,
          committee:    d.organ ?? null,
          source_url:   d.beteckning
            ? `https://www.riksdagen.se/sv/dokument-och-lagar/dokument/${d.typ}/${d.beteckning}/`
            : null,
          document_url: d.dokument_url_html ?? null,
          ingested_at:  new Date().toISOString(),
          updated_at:   new Date().toISOString(),
        }))

        const { error } = await client
          .from('documents')
          .upsert(docRows, { onConflict: 'id', ignoreDuplicates: false })
        if (error) throw error

        totalInserted += docs.length

        // Upsert authors
        const authorRows: { document_id: string; member_id: string }[] = []
        for (const d of docs) {
          if (!d.intressent) continue
          const raw = d.intressent.intressent
          const persons = Array.isArray(raw) ? raw : [raw]
          for (const p of persons) {
            if (p.intressent_id && p.roll?.toLowerCase() === 'undertecknare') {
              authorRows.push({ document_id: d.id, member_id: p.intressent_id })
            }
          }
        }
        if (authorRows.length > 0) {
          await client
            .from('document_authors')
            .upsert(authorRows, { onConflict: 'document_id,member_id', ignoreDuplicates: true })
        }

        const totalPages = parseInt(lista['@sidor'] ?? '1', 10)
        hasMore = page < totalPages
        page++
        await sleep(1100) // ~1 req/sec
      }
    }
  }

  return { inserted: totalInserted, updated: 0 }
}

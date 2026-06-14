import { z } from 'zod'
import { riksGet } from '../lib/riks-client'
import { S3Sink } from '../lib/s3-sink'
import { getCursor, setCursor } from '../lib/cursor'
import { startRun, finishRun } from '../lib/runs'
import { log } from '../lib/logger'

const RAW_BUCKET = process.env.RAW_BUCKET!

const DOKTYP_VALUES = ['mot', 'prop', 'bet', 'skr', 'ip', 'fr'] as const
type Doktyp = (typeof DOKTYP_VALUES)[number]

const EventSchema = z.object({ doktyp: z.enum(DOKTYP_VALUES) })

const DokumentSchema = z.object({
  id: z.string(),
  typ: z.string().optional(),
  rm: z.string().optional(),
  beteckning: z.string().optional(),
  titel: z.string().optional(),
  undertitel: z.string().optional(),
  status: z.string().optional(),
  datum: z.string().optional(),
  organ: z.string().optional(),
  dokument_url_html: z.string().optional(),
})

const DokumentListaSchema = z.object({
  dokumentlista: z.object({
    dokument: z.union([DokumentSchema, z.array(DokumentSchema)]).optional(),
    '@sidor': z.string().optional(),
    '@sida': z.string().optional(),
    '@traffar': z.string().optional(),
  }),
})

function makeSlug(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z'
}

export const handler = async (event: unknown): Promise<{
  ok: boolean; rows: number; pages: number; cursor_after: string | null
}> => {
  const { doktyp } = EventSchema.parse(event)
  const slug = makeSlug(new Date())
  const cursorKey = `riks/dokumentlista/${doktyp}`
  const cursorBefore = await getCursor(cursorKey)
  const runId = await startRun('riks/dokumentlista')
  const started = Date.now()

  log.info({ event: 'ingest.riks.documents.start', doktyp, cursor_before: cursorBefore }, 'start')

  const sink = new S3Sink(RAW_BUCKET, `riks/dokumentlista/doktyp=${doktyp}`, slug)
  const seenIds = new Set<string>()
  let partNum = 0
  let totalRows = 0
  let maxDokId: string | null = null
  let done = false
  let page = 1

  while (!done) {
    const data = await riksGet(
      '/dokumentlista/',
      { doktyp, p: String(page), sz: '50', sort: 'datum', sortorder: 'desc' },
      DokumentListaSchema,
    )
    const raw = data.dokumentlista.dokument
    if (!raw) break

    const docs = Array.isArray(raw) ? raw : [raw]
    if (docs.length === 0) break

    const newDocs: typeof docs = []
    for (const doc of docs) {
      if (seenIds.has(doc.id)) continue
      seenIds.add(doc.id)
      newDocs.push(doc)
      if (maxDokId === null) maxDokId = doc.id
      if (cursorBefore && doc.id === cursorBefore) { done = true; break }
    }

    if (newDocs.length > 0) {
      await sink.writePage(partNum++, newDocs)
      totalRows += newDocs.length
    }

    if (!done) {
      const totalPages = parseInt(data.dokumentlista['@sidor'] ?? '1', 10)
      if (page >= totalPages) done = true
      else page++
    }
  }

  const ingestedAt = new Date().toISOString()
  await sink.writeManifest({
    source: 'riks/dokumentlista',
    doktyp,
    ingested_at: ingestedAt,
    parts: partNum,
    total_rows: totalRows,
    cursor_after: maxDokId ?? undefined,
  })

  if (maxDokId) await setCursor(cursorKey, maxDokId)
  await finishRun('riks/dokumentlista', runId, { pages: partNum, total_rows: totalRows, errors_count: 0 })

  emitMetric('IngestNewDocs', totalRows, doktyp)
  log.info({
    event: 'ingest.riks.documents.end', doktyp, pages: partNum, rows: totalRows,
    duration_ms: Date.now() - started, status: 'success', cursor_before: cursorBefore, cursor_after: maxDokId,
  }, 'end')

  return { ok: true, rows: totalRows, pages: partNum, cursor_after: maxDokId }
}

function emitMetric(name: string, value: number, doktyp: Doktyp): void {
  process.stdout.write(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: 'Agora', Dimensions: [['Doktyp']], Metrics: [{ Name: name, Unit: 'Count' }] }],
      },
      Doktyp: doktyp,
      [name]: value,
    }) + '\n',
  )
}

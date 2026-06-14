import { z } from 'zod'
import { riksGet } from '../lib/riks-client'
import { S3Sink } from '../lib/s3-sink'
import { getCursor, setCursor } from '../lib/cursor'
import { startRun, finishRun } from '../lib/runs'
import { log } from '../lib/logger'

const RAW_BUCKET = process.env.RAW_BUCKET!

const EventSchema = z.object({ rm: z.string().min(1) })

const AnforandeSchema = z.object({
  anforande_id: z.string(),
  anforande_nummer: z.string().optional(),
  intressent_id: z.string().optional(),
  namn: z.string().optional(),
  parti: z.string().optional(),
  rm: z.string().optional(),
  datum: z.string().optional(),
  dok_id: z.string().optional(),
  kammaraktivitet: z.string().optional(),
})

const AnforandeListaSchema = z.object({
  anforandelista: z.object({
    anforande: z.union([AnforandeSchema, z.array(AnforandeSchema)]).optional(),
    '@sidor': z.string().optional(),
    '@sida': z.string().optional(),
  }),
})

function makeSlug(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z'
}

export const handler = async (event: unknown): Promise<{
  ok: boolean; rows: number; pages: number; cursor_after: string | null
}> => {
  const { rm } = EventSchema.parse(event)
  const slug = makeSlug(new Date())
  const cursorKey = `riks/anforandelista/${rm}`
  const cursorBefore = await getCursor(cursorKey)
  const runId = await startRun('riks/anforandelista')
  const started = Date.now()

  log.info({ event: 'ingest.riks.speeches.start', rm, cursor_before: cursorBefore }, 'start')

  const sink = new S3Sink(RAW_BUCKET, `riks/anforandelista/rm=${rm.replace('/', '-')}`, slug)
  const seenIds = new Set<string>()
  let partNum = 0
  let totalRows = 0
  let maxAnforandeId: string | null = null
  let done = false
  let page = 1

  while (!done) {
    const data = await riksGet(
      '/anforandelista/',
      { rm, p: String(page), sz: '50' },
      AnforandeListaSchema,
    )
    const raw = data.anforandelista.anforande
    if (!raw) break

    const speeches = Array.isArray(raw) ? raw : [raw]
    if (speeches.length === 0) break

    const newSpeeches: typeof speeches = []
    for (const s of speeches) {
      if (seenIds.has(s.anforande_id)) continue
      seenIds.add(s.anforande_id)
      newSpeeches.push(s)
      if (maxAnforandeId === null) maxAnforandeId = s.anforande_id
      if (cursorBefore && s.anforande_id === cursorBefore) { done = true; break }
    }

    if (newSpeeches.length > 0) {
      await sink.writePage(partNum++, newSpeeches)
      totalRows += newSpeeches.length
    }

    if (!done) {
      const totalPages = parseInt(data.anforandelista['@sidor'] ?? '1', 10)
      if (page >= totalPages) done = true
      else page++
    }
  }

  const ingestedAt = new Date().toISOString()
  await sink.writeManifest({
    source: 'riks/anforandelista',
    rm,
    ingested_at: ingestedAt,
    parts: partNum,
    total_rows: totalRows,
    cursor_after: maxAnforandeId ?? undefined,
  })

  if (maxAnforandeId) await setCursor(cursorKey, maxAnforandeId)
  await finishRun('riks/anforandelista', runId, { pages: partNum, total_rows: totalRows, errors_count: 0 })

  log.info({
    event: 'ingest.riks.speeches.end', rm, pages: partNum, rows: totalRows,
    duration_ms: Date.now() - started, status: 'success', cursor_before: cursorBefore, cursor_after: maxAnforandeId,
  }, 'end')

  return { ok: true, rows: totalRows, pages: partNum, cursor_after: maxAnforandeId }
}

import { z } from 'zod'
import { riksGet } from '../lib/riks-client'
import { S3Sink } from '../lib/s3-sink'
import { startRun, finishRun } from '../lib/runs'
import { log } from '../lib/logger'

const RAW_BUCKET = process.env.RAW_BUCKET!

const PersonSchema = z.object({
  intressent_id: z.string(),
  tilltalsnamn: z.string().optional(),
  efternamn: z.string().optional(),
  parti: z.string().optional(),
  valkrets: z.string().optional(),
  status: z.string().optional(),
  fodd_ar: z.string().optional(),
  kon: z.string().optional(),
  bild_url_80: z.string().optional(),
})

const PersonListaSchema = z.object({
  personlista: z.object({
    person: z.union([PersonSchema, z.array(PersonSchema)]).optional(),
  }),
})

function makeSlug(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z'
}

export const handler = async (_event: unknown): Promise<{ ok: boolean; rows: number }> => {
  const slug = makeSlug(new Date())
  const runId = await startRun('riks/personlista')
  const started = Date.now()

  log.info({ event: 'ingest.riks.members.start' }, 'start')

  const data = await riksGet('/personlista/', { rdlstatus: 'samtliga' }, PersonListaSchema)
  const raw = data.personlista.person
  const members = raw == null ? [] : Array.isArray(raw) ? raw : [raw]

  const sink = new S3Sink(RAW_BUCKET, 'riks/personlista', slug)
  await sink.writePage(0, members)

  const ingestedAt = new Date().toISOString()
  await sink.writeManifest({
    source: 'riks/personlista',
    ingested_at: ingestedAt,
    parts: 1,
    total_rows: members.length,
  })

  await finishRun('riks/personlista', runId, { pages: 1, total_rows: members.length, errors_count: 0 })

  emitMetric('IngestNewRows', members.length)
  log.info({ event: 'ingest.riks.members.end', rows: members.length, pages: 1, duration_ms: Date.now() - started, status: 'success' }, 'end')

  return { ok: true, rows: members.length }
}

function emitMetric(name: string, value: number): void {
  process.stdout.write(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: 'Agora', Dimensions: [['Source']], Metrics: [{ Name: name, Unit: 'Count' }] }],
      },
      Source: 'riks/personlista',
      [name]: value,
    }) + '\n',
  )
}

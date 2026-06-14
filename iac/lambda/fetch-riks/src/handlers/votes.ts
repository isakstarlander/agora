import { z } from 'zod'
import { riksGet } from '../lib/riks-client'
import { S3Sink } from '../lib/s3-sink'
import { getCursor, setCursor } from '../lib/cursor'
import { startRun, finishRun } from '../lib/runs'
import { log } from '../lib/logger'

const RAW_BUCKET = process.env.RAW_BUCKET!

const EventSchema = z.object({ rm: z.string().min(1) })

const VoteringSchema = z.object({
  votering_id: z.string(),
  rm: z.string().optional(),
  beteckning: z.string().optional(),
  punkt: z.string().optional(),
  datum: z.string().optional(),
  Ja: z.string().optional(),
  Nej: z.string().optional(),
  Frånvarande: z.string().optional(),
  Avstår: z.string().optional(),
})

const VoteringListaSchema = z.object({
  voteringlista: z.object({
    votering: z.union([VoteringSchema, z.array(VoteringSchema)]).optional(),
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
  const cursorKey = `riks/voteringlista/${rm}`
  const cursorBefore = await getCursor(cursorKey)
  const runId = await startRun('riks/voteringlista')
  const started = Date.now()

  log.info({ event: 'ingest.riks.votes.start', rm, cursor_before: cursorBefore }, 'start')

  const sink = new S3Sink(RAW_BUCKET, `riks/voteringlista/rm=${rm.replace('/', '-')}`, slug)
  const seenIds = new Set<string>()
  let partNum = 0
  let totalRows = 0
  let maxVoteringId: string | null = null
  let done = false
  let page = 1

  while (!done) {
    const data = await riksGet(
      '/voteringlista/',
      { rm, p: String(page), sz: '50' },
      VoteringListaSchema,
    )
    const raw = data.voteringlista.votering
    if (!raw) break

    const votes = Array.isArray(raw) ? raw : [raw]
    if (votes.length === 0) break

    const newVotes: typeof votes = []
    for (const v of votes) {
      if (seenIds.has(v.votering_id)) continue
      seenIds.add(v.votering_id)
      newVotes.push(v)
      if (maxVoteringId === null) maxVoteringId = v.votering_id
      if (cursorBefore && v.votering_id === cursorBefore) { done = true; break }
    }

    if (newVotes.length > 0) {
      await sink.writePage(partNum++, newVotes)
      totalRows += newVotes.length
    }

    if (!done) {
      const totalPages = parseInt(data.voteringlista['@sidor'] ?? '1', 10)
      if (page >= totalPages) done = true
      else page++
    }
  }

  const ingestedAt = new Date().toISOString()
  await sink.writeManifest({
    source: 'riks/voteringlista',
    rm,
    ingested_at: ingestedAt,
    parts: partNum,
    total_rows: totalRows,
    cursor_after: maxVoteringId ?? undefined,
  })

  if (maxVoteringId) await setCursor(cursorKey, maxVoteringId)
  await finishRun('riks/voteringlista', runId, { pages: partNum, total_rows: totalRows, errors_count: 0 })

  log.info({
    event: 'ingest.riks.votes.end', rm, pages: partNum, rows: totalRows,
    duration_ms: Date.now() - started, status: 'success', cursor_before: cursorBefore, cursor_after: maxVoteringId,
  }, 'end')

  return { ok: true, rows: totalRows, pages: partNum, cursor_after: maxVoteringId }
}

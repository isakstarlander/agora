import { getSupabaseClient, startIngestionRun, finishIngestionRun, sleep } from './utils.js'
import { ingestMembers } from './members.js'
import { ingestDocuments } from './documents.js'
import { ingestVotes } from './voting.js'
import { ingestDocumentTexts } from './document-texts.js'
import { ingestDocumentAuthors } from './document-authors.js'

/** Returns the riksmöten to ingest: current + previous */
function getRiksmotenToIngest(): string[] {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  const currentYear = month >= 9 ? year : year - 1
  return [
    `${currentYear}/${String(currentYear + 1).slice(2)}`,
    `${currentYear - 1}/${String(currentYear).slice(2)}`,
  ]
}

async function main() {
  const client = getSupabaseClient()
  const rms = getRiksmotenToIngest()
  console.log(`Starting Riksdagen ingestion for riksmöten: ${rms.join(', ')}`)

  const runId = await startIngestionRun(client, 'riksdagen')
  const errors: unknown[] = []
  let totalProcessed = 0
  let totalInserted = 0
  let totalUpdated = 0

  try {
    console.log('Ingesting members...')
    const memberCounts = await ingestMembers(client)
    totalProcessed += memberCounts.inserted + memberCounts.updated
    totalUpdated   += memberCounts.updated
    await sleep(2000)

    console.log('Ingesting documents...')
    const docCounts = await ingestDocuments(client, rms)
    totalProcessed += docCounts.inserted + docCounts.updated
    totalInserted  += docCounts.inserted
    totalUpdated   += docCounts.updated
    await sleep(2000)

    console.log('Ingesting votes...')
    const voteCounts = await ingestVotes(client, rms)
    totalProcessed += voteCounts.inserted + voteCounts.updated
    totalInserted  += voteCounts.inserted
    await sleep(2000)

    console.log('Fetching document text bodies...')
    const textCounts = await ingestDocumentTexts(client)
    totalProcessed += textCounts.inserted + textCounts.skipped
    totalInserted  += textCounts.inserted
    await sleep(2000)

    console.log('Fetching document authors...')
    const authorCounts = await ingestDocumentAuthors(client)
    totalProcessed += authorCounts.inserted + authorCounts.skipped
    totalInserted  += authorCounts.inserted
    await sleep(2000)

    console.log(`Ingestion complete. Processed: ${totalProcessed}`)
  } catch (err) {
    console.error('Fatal ingestion error:', err)
    errors.push(String(err))
  }

  await finishIngestionRun(client, runId, {
    processed: totalProcessed,
    inserted:  totalInserted,
    updated:   totalUpdated,
  }, errors)

  if (errors.length > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

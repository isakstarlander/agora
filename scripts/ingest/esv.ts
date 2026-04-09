import { createWriteStream, createReadStream } from 'node:fs'
import { mkdir, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import Papa from 'papaparse'
import {
  getSupabaseClient,
  startIngestionRun,
  finishIngestionRun,
  sleep,
} from './utils.js'

// ESV merged into Statskontoret; new URL pattern as of 2025.
const BASE_URL = 'https://www.statskontoret.se'

/**
 * Build the Statskontoret URL for the expenditure (Utgift) definitiv ZIP.
 * Each year's file contains all expenditure data from 1997 up to that year.
 */
function getEsvUrl(year: number): string {
  const fileName = encodeURIComponent(
    `\u00c5rsutfall utgifter 1997 - ${year}, definitivt.zip`,
  )
  return (
    `${BASE_URL}/OpenDataArsUtfallPage/GetFile` +
    `?documentType=Utgift&fileType=Zip&fileName=${fileName}&Year=${year}&month=0&status=Definitiv`
  )
}

const TMP_DIR = '/tmp/esv-ingest'

interface EsvRow {
  [key: string]: string
}

interface NormalisedRow {
  year: number
  month: number
  expenditure_area_code: string
  expenditure_area_name: string | null
  anslag_code: string | null
  anslag_name: string | null
  agency: string | null
  amount_sek: number
  budget_type: string
}

/**
 * Parse a row from the new Statskontoret multi-year CSV.
 *
 * Column names (UTF-8, semicolon-delimited):
 *   Utgiftsområde, Utgiftsområdesnamn, Anslag, Anslagsnamn, År,
 *   Ingående överföringsbelopp, Statens budget, Ändringsbudgetar,
 *   Indragningar, Utnyttjad del av medgivet överskridande, Utfall, …
 *
 * Amounts use Swedish decimal notation (comma separator) and are in MSEK.
 * month = 0 represents full-year (annual) data.
 */
function normaliseEsvRow(row: EsvRow): NormalisedRow | null {
  const yearRaw = row['År']?.trim()
  if (!yearRaw) return null
  const year = parseInt(yearRaw, 10)
  if (isNaN(year)) return null

  // Skip summary rows (Utgiftstak, Marginal, etc.) that lack an expenditure area code
  const uoCode = row['Utgiftsområde']?.trim() || ''
  if (!uoCode) return null

  // Utfall column; Swedish decimal comma; unit = MSEK
  const utfallRaw = row['Utfall']?.replace(/\s/g, '').replace(',', '.')
  if (!utfallRaw || utfallRaw === '') return null
  const amountMsek = parseFloat(utfallRaw)
  if (isNaN(amountMsek)) return null

  return {
    year,
    month:                 0,  // annual data; 0 = full year (required for upsert key)
    expenditure_area_code: uoCode,
    expenditure_area_name: row['Utgiftsområdesnamn']?.trim() || null,
    anslag_code:           row['Anslag']?.trim() || null,
    anslag_name:           row['Anslagsnamn']?.trim() || null,
    agency:                null,  // not available in new format
    amount_sek:            amountMsek * 1_000_000,  // MSEK → SEK
    budget_type:           'utfall',
  }
}

/**
 * Find the latest available definitiv file, download it, and parse all rows.
 * The multi-year file covers 1997 up to `fileYear` — one download replaces
 * the old per-year loop.
 */
async function downloadAndParse(currentYear: number): Promise<NormalisedRow[]> {
  await mkdir(TMP_DIR, { recursive: true })

  // Current year likely has no definitiv data yet; probe backwards
  let fetchUrl: string | null = null
  let fileYear = 0
  for (let y = currentYear - 1; y >= currentYear - 3; y--) {
    const url = getEsvUrl(y)
    const probe = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) })
    const len   = Number(probe.headers.get('content-length') ?? 0)
    if (probe.ok && len > 1_000) { fetchUrl = url; fileYear = y; break }
  }
  if (!fetchUrl) throw new Error('Could not find a recent definitiv ESV file')

  console.log(`  Downloading multi-year expenditure file (1997\u2013${fileYear})\u2026`)
  const zipPath = join(TMP_DIR, 'esv_latest.zip')
  const csvDir  = join(TMP_DIR, 'esv_latest')
  await mkdir(csvDir, { recursive: true })

  const res = await fetch(fetchUrl, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ESV data`)
  await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(zipPath))

  const unzipper = await import('unzipper')
  await pipeline(createReadStream(zipPath), unzipper.Extract({ path: csvDir }))

  const files    = await readdir(csvDir)
  const csvFiles = files.filter(f => f.toLowerCase().endsWith('.csv'))

  const rows: NormalisedRow[] = []
  for (const csvFile of csvFiles) {
    const content = await new Promise<string>((resolve, reject) => {
      let data = ''
      const stream = createReadStream(join(csvDir, csvFile))
      stream.on('data', chunk => { data += (chunk as Buffer).toString('utf-8') })
      stream.on('end', () => resolve(data))
      stream.on('error', reject)
    })

    const parsed = Papa.parse<EsvRow>(content, {
      header:         true,
      skipEmptyLines: true,
      delimiter:      ';',
    })
    for (const row of parsed.data) {
      const n = normaliseEsvRow(row)
      if (n) rows.push(n)
    }
  }

  await unlink(zipPath).catch(() => {})
  return rows
}

async function main() {
  const client = getSupabaseClient()
  const runId  = await startIngestionRun(client, 'esv')
  const errors: unknown[] = []
  let totalProcessed = 0
  let totalInserted  = 0

  const currentYear = new Date().getFullYear()
  const oldestYear  = currentYear - 10

  try {
    const allRows   = await downloadAndParse(currentYear)
    const validRows = allRows.filter(r => r.year >= oldestYear)
    console.log(`  Parsed ${allRows.length} total rows; keeping ${validRows.length} (${oldestYear}\u2013)`)

    totalProcessed = validRows.length

    const BATCH = 500
    for (let i = 0; i < validRows.length; i += BATCH) {
      const batch = validRows.slice(i, i + BATCH)
      const { error } = await client
        .from('budget_outcomes')
        .upsert(batch, { onConflict: 'year,month,anslag_code,budget_type', ignoreDuplicates: false })
      if (error) throw error
      totalInserted += batch.length
      await sleep(200)
    }
    console.log(`  Ingested ${totalInserted} rows`)
  } catch (err) {
    console.error('ESV ingestion failed:', err)
    errors.push(String(err))
  }

  await finishIngestionRun(client, runId, {
    processed: totalProcessed,
    inserted:  totalInserted,
    updated:   0,
  }, errors)

  console.log(`ESV ingestion complete. Rows: ${totalInserted}`)
  if (errors.length > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

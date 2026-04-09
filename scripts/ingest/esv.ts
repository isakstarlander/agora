import { createWriteStream, createReadStream } from 'node:fs'
import { mkdir, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import Papa from 'papaparse'
import { createReadStream as fsReadStream } from 'node:fs'
import {
  getSupabaseClient,
  startIngestionRun,
  finishIngestionRun,
  sleep,
} from './utils.js'

function getEsvUrl(year: number): string {
  return `https://www.esv.se/psidata/arsutfall/GetFile?year=${year}`
}

const TMP_DIR = '/tmp/esv-ingest'

interface EsvRow {
  [key: string]: string
}

function findKey(row: EsvRow, candidates: string[]): string | undefined {
  return candidates.find(c =>
    Object.keys(row).some(k => k.toLowerCase().includes(c.toLowerCase()))
  )
}

interface NormalisedRow {
  year: number
  month: number | null
  expenditure_area_code: string
  expenditure_area_name: string | null
  anslag_code: string | null
  anslag_name: string | null
  agency: string | null
  amount_sek: number
  budget_type: string
}

function normaliseEsvRow(row: EsvRow, year: number): NormalisedRow | null {
  const amountKey = findKey(row, ['utfall', 'tkr', 'belopp'])
  if (!amountKey) return null

  const rawAmount = row[amountKey]?.replace(/\s/g, '').replace(',', '.')
  if (!rawAmount || rawAmount === '') return null

  const amountTsek = parseFloat(rawAmount)
  if (isNaN(amountTsek)) return null

  const monthKey   = findKey(row, ['månad', 'month'])
  const uoCodeKey  = findKey(row, ['utgiftsområde nr', 'uo nr', 'uo_nr'])
  const uoNameKey  = findKey(row, ['utgiftsområdesnamn', 'uo namn'])
  const anslagKey  = findKey(row, ['anslagsnummer', 'anslag nr'])
  const nameKey    = findKey(row, ['anslagsnamn'])
  const agencyKey  = findKey(row, ['myndighet'])

  const monthRaw = monthKey ? row[monthKey] : null
  const month    = monthRaw && monthRaw !== '0' && monthRaw !== '' ? parseInt(monthRaw, 10) : null

  return {
    year,
    month,
    expenditure_area_code: (uoCodeKey ? row[uoCodeKey] : '') || '',
    expenditure_area_name: uoNameKey ? row[uoNameKey] || null : null,
    anslag_code:           anslagKey ? row[anslagKey] || null : null,
    anslag_name:           nameKey ? row[nameKey] || null : null,
    agency:                agencyKey ? row[agencyKey] || null : null,
    amount_sek:            amountTsek * 1000, // TSEK → SEK
    budget_type:           'utfall',
  }
}

async function downloadAndParseYear(year: number): Promise<(NormalisedRow | null)[]> {
  await mkdir(TMP_DIR, { recursive: true })
  const zipPath = join(TMP_DIR, `esv_${year}.zip`)
  const csvDir  = join(TMP_DIR, `esv_${year}`)
  await mkdir(csvDir, { recursive: true })

  const url = getEsvUrl(year)
  console.log(`  Downloading ESV data for ${year}...`)
  const res = await fetch(url)
  if (!res.ok) {
    console.warn(`  ESV data not available for ${year}: HTTP ${res.status}`)
    return []
  }

  const writer = createWriteStream(zipPath)
  await pipeline(res.body as unknown as NodeJS.ReadableStream, writer)

  const unzipper = await import('unzipper')
  await pipeline(
    createReadStream(zipPath),
    unzipper.Extract({ path: csvDir }),
  )

  const files = await readdir(csvDir)
  const csvFiles = files.filter(f => f.toLowerCase().endsWith('.csv'))

  const rows: (NormalisedRow | null)[] = []
  for (const csvFile of csvFiles) {
    const content = await new Promise<string>((resolve, reject) => {
      let data = ''
      const stream = fsReadStream(join(csvDir, csvFile))
      stream.on('data', chunk => { data += (chunk as Buffer).toString('latin1') })
      stream.on('end', () => resolve(data))
      stream.on('error', reject)
    })

    const parsed = Papa.parse<EsvRow>(content, {
      header: true,
      skipEmptyLines: true,
      delimiter: ';',
    })

    for (const row of parsed.data) {
      rows.push(normaliseEsvRow(row, year))
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
  const years = Array.from({ length: 10 }, (_, i) => currentYear - i)

  for (const year of years) {
    try {
      const rows = await downloadAndParseYear(year)
      const validRows = rows.filter((r): r is NormalisedRow => r !== null)
      if (validRows.length === 0) continue

      totalProcessed += validRows.length

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
      console.log(`  Year ${year}: ${validRows.length} rows ingested`)
    } catch (err) {
      console.warn(`  Failed for year ${year}:`, err)
      errors.push({ year, error: String(err) })
    }
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

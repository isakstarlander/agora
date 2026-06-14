import * as fs from 'fs'
import * as path from 'path'
import { MockAgent, setGlobalDispatcher } from 'undici'
import { mockClient } from 'aws-sdk-client-mock'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

// Set required env vars before any module imports
process.env.RAW_BUCKET = 'agora-raw-test'
process.env.CURSOR_TABLE = 'agora_ingest_cursors'
process.env.RUNS_TABLE = 'agora_ingestion_runs'

const s3Mock = mockClient(S3Client)
const ddbMock = mockClient(DynamoDBDocumentClient)

// Load the 5 fixture files (real Riksdagen responses, @sidor overridden to "5")
const FIXTURE_DIR = path.join(__dirname, 'fixtures')
function loadFixture(page: number): string {
  const raw = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, `dokumentlista-mot-p${page}.json`), 'utf8')
  )
  raw.dokumentlista['@sidor'] = '5'  // cap at 5 pages for deterministic test
  return JSON.stringify(raw)
}

let agent: MockAgent
let handler: typeof import('../src/handlers/documents').handler

beforeAll(async () => {
  agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  ;({ handler } = await import('../src/handlers/documents'))
})

afterAll(async () => {
  await agent.close()
})

beforeEach(() => {
  s3Mock.reset()
  ddbMock.reset()
})

describe('documents handler integration', () => {
  it('writes 5 part files and a manifest, advances cursor', async () => {
    // No existing cursor (fresh run)
    ddbMock.on(GetCommand).resolves({ Item: undefined })
    ddbMock.on(PutCommand).resolves({})
    ddbMock.on(UpdateCommand).resolves({})
    s3Mock.on(PutObjectCommand).resolves({})

    const pool = agent.get('https://data.riksdagen.se')
    for (let p = 1; p <= 5; p++) {
      pool
        .intercept({ path: /dokumentlista/, method: 'GET' })
        .reply(200, loadFixture(p), { headers: { 'content-type': 'application/json' } })
    }

    const result = await handler({ doktyp: 'mot' })

    expect(result.ok).toBe(true)
    expect(result.rows).toBe(250)   // 5 pages × 50 docs
    expect(result.pages).toBe(5)

    // 5 part files + 1 manifest = 6 PutObject calls
    const s3Calls = s3Mock.commandCalls(PutObjectCommand)
    expect(s3Calls).toHaveLength(6)

    const manifestCall = s3Calls.find(c =>
      (c.args[0].input.Key as string).endsWith('manifest.json')
    )
    expect(manifestCall).toBeDefined()

    const manifest = JSON.parse(
      Buffer.from(manifestCall!.args[0].input.Body as Buffer).toString()
    )
    expect(manifest.parts).toBe(5)
    expect(manifest.total_rows).toBe(250)
    expect(manifest.doktyp).toBe('mot')

    // cursor advanced to first doc of first page (sorted desc = newest = max id)
    const cursorWrite = ddbMock.commandCalls(PutCommand).find(c =>
      c.args[0].input.Item?.source_stream === 'riks/dokumentlista/mot'
    )
    expect(cursorWrite).toBeDefined()
    expect(cursorWrite!.args[0].input.Item?.cursor_value).toBe(result.cursor_after)
  })

  it('throws on invalid doktyp', async () => {
    await expect(handler({ doktyp: 'invalid' })).rejects.toThrow()
  })
})

import { MockAgent, setGlobalDispatcher } from 'undici'
import { mockClient } from 'aws-sdk-client-mock'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

process.env.RAW_BUCKET = 'agora-raw-test'
process.env.LOG_LEVEL = 'silent'

let agent: MockAgent
let s3Mock: ReturnType<typeof mockClient>
let handler: typeof import('../src/fetch_body').handler

beforeAll(async () => {
  agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  s3Mock = mockClient(S3Client)
  ;({ handler } = await import('../src/fetch_body'))
})

beforeEach(() => {
  s3Mock.reset()
})

afterEach(() => {
  agent.assertNoPendingInterceptors()
})

afterAll(async () => {
  await agent.close()
})

const pool = () => agent.get('https://data.riksdagen.se')
const event = { dok_id: 'hd024201', doktyp: 'mot', ingested: '2026-06-14T06-15-00Z' }

describe('fetch_body handler', () => {
  it('fetches body, writes to S3, returns skipped=false', async () => {
    pool()
      .intercept({ path: '/dokument/hd024201.text', method: 'GET' })
      .reply(200, 'Riksdagen body text content', { headers: { 'content-type': 'text/plain' } })
    s3Mock.on(PutObjectCommand).resolves({})

    const result = await handler(event)

    expect(result.skipped).toBe(false)
    expect(result.s3_key).toBe('riks/document-text/hd024201.txt.gz')
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1)
    const putCall = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input
    expect(putCall.Key).toBe('riks/document-text/hd024201.txt.gz')
    expect(putCall.ContentEncoding).toBe('gzip')
  })

  it('returns skipped=true on 404 without writing to S3', async () => {
    pool()
      .intercept({ path: '/dokument/hd024201.text', method: 'GET' })
      .reply(404, '', {})

    const result = await handler(event)

    expect(result.skipped).toBe(true)
    expect(result.s3_key).toBeNull()
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0)
  })

  it('retries on 429 and succeeds on second attempt', async () => {
    pool()
      .intercept({ path: '/dokument/hd024201.text', method: 'GET' })
      .reply(429, '', { headers: { 'retry-after': '0' } })
    pool()
      .intercept({ path: '/dokument/hd024201.text', method: 'GET' })
      .reply(200, 'body text', { headers: { 'content-type': 'text/plain' } })
    s3Mock.on(PutObjectCommand).resolves({})

    const result = await handler(event)
    expect(result.skipped).toBe(false)
  })

  it('throws after exhausting all retries', async () => {
    for (let i = 0; i < 5; i++) {
      pool()
        .intercept({ path: '/dokument/hd024201.text', method: 'GET' })
        .reply(503, '', {})
    }

    await expect(handler(event)).rejects.toThrow(/503/)
  })
})

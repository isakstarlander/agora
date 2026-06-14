import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici'
import { z } from 'zod'

const EchoSchema = z.object({ value: z.string() })

let agent: MockAgent
let riksGet: typeof import('../src/lib/riks-client').riksGet

beforeAll(async () => {
  // Use undici MockAgent so it intercepts undici.request() calls
  agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  ;({ riksGet } = await import('../src/lib/riks-client'))
})

afterEach(() => {
  agent.assertNoPendingInterceptors()
})

afterAll(async () => {
  await agent.close()
})

const pool = () => agent.get('https://data.riksdagen.se')

describe('riksGet', () => {
  it('returns parsed JSON on 200', async () => {
    pool().intercept({ path: /personlista/, method: 'GET' })
      .reply(200, JSON.stringify({ value: 'hello', extra: 'field' }), { headers: { 'content-type': 'application/json' } })

    const result = await riksGet('/personlista/', {}, EchoSchema)
    expect(result.value).toBe('hello')
  })

  it('retries on 429 and succeeds on second attempt', async () => {
    pool().intercept({ path: /personlista/, method: 'GET' })
      .reply(429, '', { headers: { 'retry-after': '0' } })
    pool().intercept({ path: /personlista/, method: 'GET' })
      .reply(200, JSON.stringify({ value: 'ok' }), { headers: { 'content-type': 'application/json' } })

    const result = await riksGet('/personlista/', {}, EchoSchema)
    expect(result.value).toBe('ok')
  })

  it('retries on 503 up to three times then succeeds', async () => {
    pool().intercept({ path: /personlista/, method: 'GET' }).reply(503, '')
    pool().intercept({ path: /personlista/, method: 'GET' }).reply(503, '')
    pool().intercept({ path: /personlista/, method: 'GET' }).reply(503, '')
    pool().intercept({ path: /personlista/, method: 'GET' })
      .reply(200, JSON.stringify({ value: 'recovered' }), { headers: { 'content-type': 'application/json' } })

    const result = await riksGet('/personlista/', {}, EchoSchema)
    expect(result.value).toBe('recovered')
  })

  it('throws after exhausting all retries', async () => {
    for (let i = 0; i < 5; i++) {
      pool().intercept({ path: /personlista/, method: 'GET' }).reply(503, '')
    }
    await expect(riksGet('/personlista/', {}, EchoSchema)).rejects.toThrow(/503/)
  })

  it('logs warn and returns raw data on schema mismatch', async () => {
    pool().intercept({ path: /personlista/, method: 'GET' })
      .reply(200, JSON.stringify({ unexpected: 123 }), { headers: { 'content-type': 'application/json' } })

    const result = await riksGet('/personlista/', {}, EchoSchema)
    expect((result as Record<string, unknown>).unexpected).toBe(123)
  })
})

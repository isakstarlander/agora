import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'

process.env.CURSOR_TABLE = 'agora_ingest_cursors'

// Must mock before importing cursor module
const ddbMock = mockClient(DynamoDBDocumentClient)

import { getCursor, setCursor } from '../src/lib/cursor'

beforeEach(() => {
  ddbMock.reset()
})

describe('getCursor', () => {
  it('returns null when item does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined })
    const result = await getCursor('riks/dokumentlista/mot')
    expect(result).toBeNull()
  })

  it('returns cursor_value when item exists', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { source_stream: 'riks/dokumentlista/mot', cursor_value: 'HB02MOT123' } })
    const result = await getCursor('riks/dokumentlista/mot')
    expect(result).toBe('HB02MOT123')
  })
})

describe('setCursor', () => {
  it('calls PutCommand with correct key and value', async () => {
    ddbMock.on(PutCommand).resolves({})
    await setCursor('riks/dokumentlista/mot', 'HB02MOT999')

    const calls = ddbMock.commandCalls(PutCommand)
    expect(calls).toHaveLength(1)
    expect(calls[0].args[0].input.Item).toMatchObject({
      source_stream: 'riks/dokumentlista/mot',
      cursor_value: 'HB02MOT999',
    })
  })
})

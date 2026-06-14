import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { ulid } from 'ulid'

const TABLE = process.env.RUNS_TABLE!
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const TTL_SECONDS = 180 * 86_400

export interface RunStats {
  pages: number
  total_rows: number
  errors_count: number
}

export async function startRun(source: string): Promise<string> {
  const run_id = ulid()
  await client.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        source,
        run_id,
        started_at: new Date().toISOString(),
        status: 'running',
        expires_at: Math.floor(Date.now() / 1000) + TTL_SECONDS,
      },
    }),
  )
  return run_id
}

export async function finishRun(
  source: string,
  run_id: string,
  stats: RunStats,
): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { source, run_id },
      UpdateExpression:
        'SET ended_at = :e, pages = :p, total_rows = :r, errors_count = :ec, #s = :st',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':e': new Date().toISOString(),
        ':p': stats.pages,
        ':r': stats.total_rows,
        ':ec': stats.errors_count,
        ':st': stats.errors_count > 0 ? 'error' : 'success',
      },
    }),
  )
}

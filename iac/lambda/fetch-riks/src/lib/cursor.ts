import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'

const TABLE = process.env.CURSOR_TABLE!
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}))

export async function getCursor(sourceStream: string): Promise<string | null> {
  const result = await client.send(
    new GetCommand({ TableName: TABLE, Key: { source_stream: sourceStream } }),
  )
  return (result.Item?.cursor_value as string | undefined) ?? null
}

export async function setCursor(sourceStream: string, value: string): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: TABLE,
      Item: { source_stream: sourceStream, cursor_value: value },
    }),
  )
}

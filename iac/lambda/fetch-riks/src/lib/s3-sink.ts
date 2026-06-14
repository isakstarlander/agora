import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { gzipSync } from 'zlib'

const s3 = new S3Client({})

export interface ManifestInfo {
  source: string
  ingested_at: string
  parts: number
  total_rows: number
  cursor_after?: string
  [key: string]: unknown
}

export class S3Sink {
  constructor(
    private readonly bucket: string,
    private readonly prefix: string,
    private readonly slug: string,
  ) {}

  async writePage(partNum: number, rows: unknown[]): Promise<void> {
    const key = `${this.prefix}/ingested=${this.slug}/part-${String(partNum).padStart(3, '0')}.json.gz`
    const body = gzipSync(JSON.stringify(rows))
    await s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentEncoding: 'gzip',
        ContentType: 'application/json',
      }),
    )
  }

  async writeManifest(info: ManifestInfo): Promise<void> {
    const key = `${this.prefix}/ingested=${this.slug}/manifest.json`
    await s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: Buffer.from(JSON.stringify(info, null, 2)),
        ContentType: 'application/json',
      }),
    )
  }
}

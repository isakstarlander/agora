import boto3
import gzip
import json
import os

s3 = boto3.client('s3')
RAW_BUCKET = os.environ['RAW_BUCKET']


def handler(event: dict, context: object) -> dict:
    dok_id: str = event['dok_id']
    doktyp: str = event.get('doktyp', '')
    ingested: str = event.get('ingested', 'unknown')

    index_key = f'riks/alias-index/ingested={ingested}/index.json.gz'

    # Read existing index or start fresh.
    rows: list = []
    try:
        obj = s3.get_object(Bucket=RAW_BUCKET, Key=index_key)
        rows = json.loads(gzip.decompress(obj['Body'].read()))
    except s3.exceptions.ClientError as e:
        if e.response['Error']['Code'] not in ('404', 'NoSuchKey'):
            raise

    rows.append({
        'dok_id': dok_id,
        'doktyp': doktyp,
        'detail_key': f'riks/dokument-detail/{dok_id}.json.gz',
        'body_key': f'riks/document-text/{dok_id}.txt.gz',
    })

    compressed = gzip.compress(json.dumps(rows).encode())
    s3.put_object(
        Bucket=RAW_BUCKET,
        Key=index_key,
        Body=compressed,
        ContentEncoding='gzip',
        ContentType='application/json',
    )

    return {'dok_id': dok_id, 'ok': True}

import boto3
import gzip
import json
import os
import uuid
from datetime import datetime, timezone

s3 = boto3.client('s3')
RAW_BUCKET = os.environ['RAW_BUCKET']

# In-memory cache of HEAD results for a single invocation.
_head_cache: dict[str, bool] = {}


def _exists_in_s3(key: str) -> bool:
    if key in _head_cache:
        return _head_cache[key]
    try:
        s3.head_object(Bucket=RAW_BUCKET, Key=key)
        result = True
    except s3.exceptions.ClientError as e:
        code = e.response['Error']['Code']
        if code in ('404', 'NoSuchKey'):
            result = False
        else:
            raise
    _head_cache[key] = result
    return result


def handler(event: dict, context: object) -> dict:
    manifest_key: str = event['manifest_key']

    manifest_obj = s3.get_object(Bucket=RAW_BUCKET, Key=manifest_key)
    manifest = json.loads(manifest_obj['Body'].read())

    parts: int = manifest.get('parts', 0)
    doktyp: str = manifest.get('doktyp', '')

    # Extract ingested slug from the key path, e.g. ingested=2026-06-14T06-15-00Z
    ingested = ''
    for segment in manifest_key.split('/'):
        if segment.startswith('ingested='):
            ingested = segment[len('ingested='):]
            break

    docs = []
    for part_num in range(parts):
        part_key = manifest_key.replace('manifest.json', f'part-{part_num:03d}.json.gz')
        part_obj = s3.get_object(Bucket=RAW_BUCKET, Key=part_key)
        rows = json.loads(gzip.decompress(part_obj['Body'].read()))
        for row in rows:
            dok_id = row.get('id') or row.get('dok_id', '')
            if not dok_id:
                continue
            detail_key = f'riks/dokument-detail/{dok_id}.json.gz'
            if not _exists_in_s3(detail_key):
                docs.append({
                    'dok_id': dok_id,
                    'doktyp': row.get('typ') or doktyp,
                    'datum': row.get('datum', ''),
                })

    run_id = str(uuid.uuid4())
    started_at = datetime.now(timezone.utc).isoformat()

    return {
        'docs': docs,
        'run_id': run_id,
        'started_at': started_at,
        'ingested': ingested,
    }

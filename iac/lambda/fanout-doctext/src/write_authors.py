import boto3
import gzip
import json
import os

s3 = boto3.client('s3')
RAW_BUCKET = os.environ['RAW_BUCKET']


def handler(event: dict, context: object) -> dict:
    dok_id: str = event['dok_id']
    doktyp: str = event.get('doktyp', '')

    if doktyp != 'mot':
        return {'dok_id': dok_id, 'authors_count': 0, 'skipped': True}

    detail_key = f'riks/dokument-detail/{dok_id}.json.gz'
    obj = s3.get_object(Bucket=RAW_BUCKET, Key=detail_key)
    detail = json.loads(gzip.decompress(obj['Body'].read()))

    # The Riksdagen detail envelope: detail -> dokumentstatus -> dokument -> intressentlista -> intressent
    # Or the outer wrapper may be dokumentstatus directly.
    intressenter = []
    try:
        dok_status = detail.get('dokumentstatus', detail)
        intressentlista = dok_status.get('dokument', {}).get('intressentlista', {})
        raw = intressentlista.get('intressent', [])
        intressenter = raw if isinstance(raw, list) else [raw]
    except (AttributeError, TypeError):
        pass

    authors = [
        {
            'intressent_id': i.get('intressent_id', ''),
            'namn': i.get('namn', ''),
            'partibet': i.get('partibet', ''),
            'ordning': i.get('ordning', 0),
            'roll': i.get('roll', ''),
        }
        for i in intressenter
    ]

    authors_key = f'riks/dokument-authors/{dok_id}.json.gz'
    compressed = gzip.compress(json.dumps(authors).encode())
    s3.put_object(
        Bucket=RAW_BUCKET,
        Key=authors_key,
        Body=compressed,
        ContentEncoding='gzip',
        ContentType='application/json',
    )

    return {'dok_id': dok_id, 'authors_count': len(authors), 'skipped': False}

import boto3
import os
import time
from datetime import datetime, timezone

dynamodb = boto3.resource('dynamodb')
RUNS_TABLE = os.environ['RUNS_TABLE']


def handler(event: dict, context: object) -> dict:
    run_id: str = event.get('run_id', 'unknown')
    started_at: str = event.get('started_at', '')
    map_results: list = event.get('map_results', [])

    ended_at = datetime.now(timezone.utc).isoformat()
    count_success = sum(1 for r in map_results if r and not r.get('skipped'))
    count_skipped = sum(1 for r in map_results if r and r.get('skipped'))
    count_failure = len(map_results) - count_success - count_skipped

    expires_at = int(time.time()) + 180 * 24 * 60 * 60

    table = dynamodb.Table(RUNS_TABLE)
    table.put_item(Item={
        'source': 'riks/fanout-doctext',
        'run_id': run_id,
        'started_at': started_at,
        'ended_at': ended_at,
        'status': 'success' if count_failure == 0 else 'partial',
        'count_success': count_success,
        'count_skipped': count_skipped,
        'count_failure': count_failure,
        'expires_at': expires_at,
    })

    return {'ok': True, 'run_id': run_id, 'count_success': count_success}

import gzip
import json
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

os.environ['RAW_BUCKET'] = 'agora-raw-test'
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

MANIFEST = {
    'source': 'riks/dokumentlista',
    'doktyp': 'mot',
    'parts': 1,
    'ingested_at': '2026-06-14T06:15:00Z',
}

PART_0 = [
    {'id': 'hd024201', 'typ': 'mot', 'datum': '2026-06-12'},
    {'id': 'hb024101', 'typ': 'mot', 'datum': '2026-06-11'},
]

MANIFEST_KEY = 'riks/dokumentlista/doktyp=mot/ingested=2026-06-14T06-15-00Z/manifest.json'


def _make_s3_body(data: bytes) -> MagicMock:
    m = MagicMock()
    m.read.return_value = data
    return m


class TestListNewDocs(unittest.TestCase):
    def setUp(self):
        import list_new_docs
        list_new_docs._head_cache.clear()

    def _make_mock_s3(self, existing_dok_ids: set[str]) -> MagicMock:
        mock_s3 = MagicMock()

        def head_side_effect(Bucket, Key):
            dok_id = Key.split('/')[-1].replace('.json.gz', '')
            if dok_id in existing_dok_ids:
                return {}
            error_response = {'Error': {'Code': '404', 'Message': 'Not Found'}}
            raise mock_s3.exceptions.ClientError(error_response, 'HeadObject')

        mock_s3.get_object.side_effect = [
            {'Body': _make_s3_body(json.dumps(MANIFEST).encode())},
            {'Body': _make_s3_body(gzip.compress(json.dumps(PART_0).encode()))},
        ]
        mock_s3.head_object.side_effect = head_side_effect
        mock_s3.exceptions.ClientError = type('ClientError', (Exception,), {
            '__init__': lambda self, r, op: (
                setattr(self, 'response', r),
                setattr(self, 'operation_name', op),
            )[1] or None,
        })
        return mock_s3

    @patch('list_new_docs.s3')
    def test_filters_already_fetched_docs(self, mock_s3_module):
        # hd024201 already exists; hb024101 is new
        mock = self._make_mock_s3({'hd024201'})
        mock_s3_module.get_object.side_effect = mock.get_object.side_effect
        mock_s3_module.head_object.side_effect = mock.head_object.side_effect
        mock_s3_module.exceptions.ClientError = mock.exceptions.ClientError

        import list_new_docs
        result = list_new_docs.handler({'manifest_key': MANIFEST_KEY}, {})

        self.assertEqual(len(result['docs']), 1)
        self.assertEqual(result['docs'][0]['dok_id'], 'hb024101')
        self.assertIn('run_id', result)
        self.assertIn('started_at', result)
        self.assertEqual(result['ingested'], '2026-06-14T06-15-00Z')

    @patch('list_new_docs.s3')
    def test_returns_all_docs_when_none_exist(self, mock_s3_module):
        mock = self._make_mock_s3(set())
        mock_s3_module.get_object.side_effect = mock.get_object.side_effect
        mock_s3_module.head_object.side_effect = mock.head_object.side_effect
        mock_s3_module.exceptions.ClientError = mock.exceptions.ClientError

        import list_new_docs
        result = list_new_docs.handler({'manifest_key': MANIFEST_KEY}, {})

        self.assertEqual(len(result['docs']), 2)

    @patch('list_new_docs.s3')
    def test_returns_empty_when_all_already_fetched(self, mock_s3_module):
        mock = self._make_mock_s3({'hd024201', 'hb024101'})
        mock_s3_module.get_object.side_effect = mock.get_object.side_effect
        mock_s3_module.head_object.side_effect = mock.head_object.side_effect
        mock_s3_module.exceptions.ClientError = mock.exceptions.ClientError

        import list_new_docs
        result = list_new_docs.handler({'manifest_key': MANIFEST_KEY}, {})

        self.assertEqual(result['docs'], [])


if __name__ == '__main__':
    unittest.main()

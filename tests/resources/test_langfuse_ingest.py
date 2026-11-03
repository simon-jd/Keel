import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import langfuse_ingest as li  # noqa: E402


def span(span_id, end, ack, run='r1', cost=0.5, name='llm', ok=True):
    return {'spanId': span_id, 'traceId': 't' + span_id, 'name': name, 'endMs': end, 'ackMs': ack, 'ok': ok,
            'attributes': {'keel.run_id': run, 'keel.cost_usd': cost}}


class LangfuseIngestTests(unittest.TestCase):
    def test_stack_and_task4_batch_fit_the_16_gb_share(self):
        # Raising a service limit or the batch cap without the other breaks this.
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/resource_check.py'), 'compose'],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        services = json.loads(result.stdout)['memory_bytes']
        self.assertLessEqual(services + li.BATCH_LIMIT + li.HEADROOM, 16_000_000_000)
        self.assertGreaterEqual(li.HEADROOM, 1_000_000_000)

    def test_stack_environment_is_fresh_complete_and_never_reused(self):
        first, second = li.stack_environment(), li.stack_environment()
        self.assertNotEqual(first['LANGFUSE_INIT_PROJECT_SECRET_KEY'], second['LANGFUSE_INIT_PROJECT_SECRET_KEY'])
        self.assertRegex(first['LANGFUSE_ENCRYPTION_KEY'], r'^[0-9a-f]{64}$')
        self.assertEqual(first['OTEL_COLLECTOR_CONFIG'], './otel-collector.langfuse.yaml')
        compose = (ROOT / 'infra/docker-compose.yml').read_text()
        for name in first:
            self.assertIn('${' + name, compose, name)

    def test_percentile_is_nearest_rank(self):
        self.assertEqual(li.percentile([5, 1, 3, 2, 4], 50), 3)
        self.assertEqual(li.percentile(list(range(1, 101)), 95), 95)
        self.assertIsNone(li.percentile([], 50))

    def test_summary_counts_missing_and_extra_spans_and_measures_latency(self):
        sent = [span('a', 1000, 1100), span('b', 2000, 2100), span('c', 3000, 3050, ok=False)]
        stored = {'a': {'storedMs': 1600, 'cost': 0.5, 'runId': 'r1'}, 'z': {'storedMs': 1, 'cost': 0, 'runId': 'r9'}}
        summary = li.summarize(sent, stored, [{'runId': 'r1', 'knownUsd': 1.5}])
        self.assertEqual(summary['spans'], {'sent': 3, 'acknowledged': 2, 'stored': 1, 'missing': 2,
                                            'stored_not_sent': 1, 'missing_ids': ['b', 'c']})
        self.assertEqual(summary['latency_ms']['from_span_end']['p50'], 600)
        self.assertEqual(summary['latency_ms']['from_export_ack']['p95'], 500)
        # Run cost from Langfuse counts only stored spans: a lost span shows up as a cost mismatch.
        self.assertEqual(summary['run_cost'], [{'runId': 'r1', 'runtime_usd': 1.5, 'sent_usd': 1.5, 'langfuse_usd': 0.5, 'match': False}])

    def test_events_rows_become_stored_facts(self):
        # Langfuse v4 OTel ingestion stores spans in events_full with attributes as parallel name/value arrays.
        row = {'span_id': 'abc', 'created_at': '2026-10-29 15:01:02.250000', 'total_cost': '0',
               'metadata_names': ['attributes.keel.run_id', 'attributes.keel.cost_usd', 'scope.name'], 'metadata_values': ['r1', '0.00008505', 'keel']}
        facts = li.stored_facts([row, {**row, 'created_at': '2026-10-29 15:01:03.000000'}])
        self.assertEqual(facts, {'abc': {'storedMs': 1793286062250.0, 'cost': 0.00008505, 'runId': 'r1', 'rows': 2}})
        self.assertIsNone(li.stored_facts([{**row, 'metadata_names': [], 'metadata_values': []}])['abc']['cost'])

    def test_canary_scan_reports_where_raw_pii_appears(self):
        blobs = {'clickhouse/observations': b'{"metadata":"<PHONE_NUMBER>"}', 'minio/events/x': b'..dana@example.com..'}
        hits = li.scan_for_canaries(blobs, ['dana@example.com', '617-555-0107'])
        self.assertEqual(hits, {'minio/events/x': ['dana@example.com']})
        self.assertEqual(li.scan_for_canaries({'a': b'clean'}, ['x@example.com']), {})


if __name__ == '__main__':
    unittest.main()

from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def row(job, success, latency, status='completed', attempt=1, bench='tau2', domain='airline', seed=0, tokens=(10, 2), cost='known'):
    calls = [{'accounting': {'usage': {'input': tokens[0], 'output': tokens[1]}, 'costStatus': cost}}]
    r = {'job_id': job, 'benchmark': bench, 'task_id': str(job), 'seed': seed, 'attempt': attempt,
         'status': status, 'success': success, 'reward': float(success) if status == 'completed' else None,
         'latency_ms': latency, 'calls': calls, 'cost_known_usd': 0, 'cost_status': cost, 'model': {'name': 'm'}}
    r.update({'category': 'simple_python'} if bench == 'bfcl' else {'domain': domain})
    return r


class BenchmarkSummaryTests(unittest.TestCase):
    def test_latest_attempt_per_job_id_even_when_task_ids_repeat_across_seeds(self):
        from benchmark_summary import latest
        rows = [row(0, False, 1, status='incomplete'), row(0, True, 5, attempt=2), row(1, False, 3, seed=1)]
        rows[2]['task_id'] = '0'
        self.assertEqual({j: r['attempt'] for j, r in latest(rows).items()}, {0: 2, 1: 1})

    def test_compact_keeps_outcome_tokens_and_cost_without_trajectories(self):
        from benchmark_summary import compact
        c = compact(row(3, True, 12.345, tokens=(100, 7)))
        self.assertEqual(c, {'job_id': 3, 'benchmark': 'tau2', 'cell': 'airline', 'task_id': '3', 'seed': 0, 'attempt': 1,
                             'status': 'completed', 'success': True, 'reward': 1.0, 'latency_ms': 12.3, 'calls': 1,
                             'input_tokens': 100, 'output_tokens': 7, 'cost_status': 'known', 'cost_known_usd': 0})

    def test_summary_counts_failures_in_denominators_and_marks_unknown_cost(self):
        from benchmark_summary import compact, summarize
        jobs = [compact(r) for r in [row(0, True, 10), row(1, False, 20, status='failed', cost='unknown'), row(2, False, 30, domain='retail'),
                                     row(3, True, 40, bench='bfcl', domain=None)]]
        s = summarize(jobs)
        self.assertEqual(s['cells']['tau2/airline'], {'jobs': 2, 'successes': 1, 'original_evaluations': 1, 'failed': 1, 'incomplete': 0,
                                                     'success_rate': 0.5, 'latency_ms': {'mean': 15.0, 'median': 15.0, 'p95': 20.0},
                                                     'input_tokens': 20, 'output_tokens': 4, 'cost': 'unknown; known subtotal $0'})
        self.assertEqual(s['benchmarks']['tau2']['jobs'], 3)
        self.assertEqual(s['benchmarks']['tau2']['successes'], 1)
        self.assertEqual(s['benchmarks']['bfcl']['cost'], '$0 known')
        self.assertEqual(s['cells']['bfcl/simple_python']['jobs'], 1)


if __name__ == '__main__':
    unittest.main()

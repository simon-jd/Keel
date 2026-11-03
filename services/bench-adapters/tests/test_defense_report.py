from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class DefenseReportTests(unittest.TestCase):
    def test_wilson_matches_known_values(self):
        from defense_report import wilson
        lo, hi = wilson(0, 10); self.assertAlmostEqual(lo, 0.0); self.assertAlmostEqual(hi, 0.27753, places=4)
        lo, hi = wilson(5, 10); self.assertAlmostEqual(lo, 0.23659, places=4); self.assertAlmostEqual(hi, 0.76341, places=4)
        lo, hi = wilson(81, 263); self.assertAlmostEqual(lo, 0.25516, places=3); self.assertAlmostEqual(hi, 0.36621, places=3)
        self.assertEqual(wilson(0, 0), (None, None))

    def test_report_keeps_failed_episodes_in_denominators_and_counts_denials(self):
        from defense_report import report
        base = {'suite': 'slack', 'calls': 2, 'inputTokens': 10, 'outputTokens': 2, 'latencyMs': 100}
        rows = [{**base, 'jobId': 'a', 'policy': 'taint', 'kind': 'clean', 'status': 'completed', 'utility': False,
                 'denials': [{'op': 'dispatch', 'tool': 'send_direct_message', 'decision': 'needs_approval'}], 'blocked': True},
                {**base, 'jobId': 'b', 'policy': 'taint', 'kind': 'clean', 'status': 'completed', 'utility': True, 'denials': []},
                {**base, 'jobId': 'c', 'policy': 'taint', 'kind': 'attack', 'status': 'completed', 'utility': True, 'attackSuccess': True, 'denials': []},
                {**base, 'jobId': 'd', 'policy': 'taint', 'kind': 'attack', 'status': 'failed', 'utility': None, 'attackSuccess': None, 'calls': None}]
        result = report(rows)
        cell = result['groups']['slack']['taint']
        self.assertEqual((cell['utility']['k'], cell['utility']['n']), (1, 2))
        self.assertEqual((cell['asr']['k'], cell['asr']['n'], cell['asr']['failed']), (1, 2, 1))
        self.assertEqual(cell['asrUpperIfFailuresSucceed'], 1.0)
        self.assertEqual((cell['utilityUnderAttack']['k'], cell['utilityUnderAttack']['n']), (1, 2))
        self.assertEqual(cell['cost']['episodes'], 3)
        self.assertEqual(result['denials'], [{'suite': 'slack', 'policy': 'taint', 'op': 'dispatch', 'decision': 'needs_approval', 'tool': 'send_direct_message', 'events': 1}])
        self.assertEqual(result['cleanFailuresWithDenials'], [{'suite': 'slack', 'policy': 'taint', 'failedCleanTasksWithDenials': 1}])
        self.assertEqual(result['groups']['overall']['taint']['asr']['n'], 2)


if __name__ == '__main__':
    unittest.main()

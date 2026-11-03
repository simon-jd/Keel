from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))


class JudgeBalancedReportTests(unittest.TestCase):
    def test_kappa_textbook_value(self):
        from judge_balanced_report import kappa
        # 2x2 table [[20, 5], [10, 15]]: po = .7, pe = .5, kappa = .4
        pairs = [('y', 'y')] * 20 + [('y', 'n')] * 5 + [('n', 'y')] * 10 + [('n', 'n')] * 15
        self.assertAlmostEqual(kappa(pairs), 0.4)

    def test_formatting_only_needs_every_call_to_match_after_normalization(self):
        from judge_balanced_report import formatting_only
        truth = [{'math.hypot': {'x': [3], 'y': [4], 'z': ['', 0]}}]
        call = lambda args, name='math_hypot': {'toolCalls': [{'name': name, 'args': args}]}
        self.assertTrue(formatting_only(call({'x': 3.0, 'y': '4'}), truth))
        self.assertFalse(formatting_only(call({'x': 3, 'y': 5}), truth))
        self.assertFalse(formatting_only(call({'x': 3}), truth))
        self.assertFalse(formatting_only(call({'x': 3, 'y': 4, 'w': 1}), truth))
        self.assertTrue(formatting_only({'toolCalls': [{'name': 'f', 'args': {'city': 'new york, NY'}}]}, [{'f': {'city': ['New York NY']}}]))

    def test_report_counts_invalid_verdicts_as_disagreement_and_missed_fails(self):
        from judge_balanced_report import version_report
        reference = [{'id': 'a', 'label': 'fail'}, {'id': 'b', 'label': 'fail'}, {'id': 'c', 'label': 'pass'}, {'id': 'd', 'label': 'pass'}]
        audit = {i: {'category': 'simple_python', 'model': 'm', 'taskId': i, 'errorType': None, 'groundTruth': None} for i in 'abcd'}
        samples = {i: {'action': {'toolCalls': []}} for i in 'abcd'}
        rows = [{'id': 'a', 'label': 'fail'}, {'id': 'b', 'label': None}, {'id': 'c', 'label': 'fail'}, {'id': 'd', 'label': 'pass'}]
        r = version_report(reference, audit, samples, rows)
        self.assertEqual((r['parsed'], r['invalid'], r['rawAgreement']), (3, 1, 0.5))
        self.assertEqual((r['failPrecision'], r['failRecall']), (0.5, 0.5))
        self.assertEqual(r['confusion']['reference_fail_judge_invalid'], 1)
        self.assertEqual(len(r['disagreements']), 2)


if __name__ == '__main__':
    unittest.main()

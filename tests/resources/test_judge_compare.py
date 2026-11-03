from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))


def rows(labels):
    return [{'id': str(i), 'label': label} for i, label in enumerate(labels)]


class JudgeCompareTests(unittest.TestCase):
    def test_wilson_interval_known_values(self):
        from judge_compare import wilson
        low, high = wilson(53, 200)
        self.assertAlmostEqual(low, 0.2087, places=3)
        self.assertAlmostEqual(high, 0.3297, places=3)
        self.assertEqual(wilson(0, 0), (None, None))
        low, high = wilson(1, 5)
        self.assertAlmostEqual(low, 0.0362, places=3)
        self.assertAlmostEqual(high, 0.6245, places=3)

    def test_invalid_verdict_is_scored_as_the_label_opposite_the_reference(self):
        from judge_compare import score
        reference = rows(['fail', 'fail', 'pass', 'pass'])
        judge = [{'id': '0', 'label': 'fail'}, {'id': '1', 'label': None, 'error': 'INVALID_JUDGE_SCHEMA'}, {'id': '2', 'label': None}]
        # '3' is missing entirely: also wrong.
        result = score(reference, judge)
        self.assertEqual(result['invalid'], 3)
        self.assertEqual(result['matrix'], [[1, 1], [2, 0]])  # rows reference fail/pass, cols judge fail/pass
        self.assertEqual(result['agreement']['k'], 1)
        self.assertEqual(result['fail_precision']['k'], 1)
        self.assertEqual(result['fail_precision']['n'], 3)
        self.assertEqual(result['fail_recall']['k'], 1)
        self.assertEqual(result['fail_recall']['n'], 2)

    def test_kappa_matches_the_phase6_cohort_value_and_bootstrap_is_seeded(self):
        from judge_compare import score
        # The phase 6 v1 matrix [[53,147],[5,195]] gives kappa 0.24.
        reference = rows(['fail'] * 200 + ['pass'] * 200)
        labels = ['fail'] * 53 + ['pass'] * 147 + ['fail'] * 5 + ['pass'] * 195
        judge = [{'id': str(i), 'label': label} for i, label in enumerate(labels)]
        first, second = score(reference, judge), score(reference, judge)
        self.assertAlmostEqual(first['kappa'], 0.24)
        self.assertEqual(first['kappa_ci'], second['kappa_ci'])
        self.assertLess(first['kappa_ci'][0], 0.24)
        self.assertGreater(first['kappa_ci'][1], 0.24)

    def test_selection_rule_eligibility_tie_break_and_replacement_threshold(self):
        from judge_compare import select
        def cand(kappa, recall, precision=0.9, invalid=0, human_invalid=0, thinking=False, version='v1'):
            return {'kappa': kappa, 'fail_recall': {'p': recall}, 'fail_precision': {'p': precision}, 'invalid': invalid,
                    'human_invalid': human_invalid, 'thinking': thinking, 'version': version}
        # Too many invalid verdicts on either set makes a candidate ineligible.
        result = select({'a': cand(0.60, 0.5, invalid=9), 'b': cand(0.50, 0.5, human_invalid=7), 'c': cand(0.31, 0.4)}, current_kappa=0.24)
        self.assertEqual(result['winner'], 'c')
        self.assertEqual(sorted(result['ineligible']), ['a', 'b'])
        self.assertTrue(result['replace'])
        # Within 0.01 kappa: higher fail recall wins, then non-thinking, then lexical version.
        self.assertEqual(select({'x': cand(0.400, 0.40), 'y': cand(0.405, 0.30)}, 0.24)['winner'], 'x')
        self.assertEqual(select({'t': cand(0.40, 0.4, thinking=True), 'n': cand(0.40, 0.4)}, 0.24)['winner'], 'n')
        self.assertEqual(select({'p': cand(0.40, 0.4, version='v2'), 'q': cand(0.40, 0.4, version='v1')}, 0.24)['winner'], 'q')
        # Replacement needs kappa >= current + 0.05 and fail precision >= 0.80.
        self.assertFalse(select({'a': cand(0.289, 0.5)}, 0.24)['replace'])
        self.assertTrue(select({'a': cand(0.290, 0.5)}, 0.24)['replace'])
        self.assertFalse(select({'a': cand(0.50, 0.9, precision=0.79)}, 0.24)['replace'])
        self.assertIsNone(select({'a': cand(0.5, 0.5, invalid=20)}, 0.24)['winner'])


if __name__ == '__main__':
    unittest.main()

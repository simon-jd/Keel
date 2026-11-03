from pathlib import Path
import json
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))


def units(counts):
    out = {}
    for category, (passes, fails) in counts.items():
        for label, n in (('pass', passes), ('fail', fails)):
            for i in range(n):
                digest = f'{category}-{label}-{i}'
                out[digest] = {'unit': {'input': {'messages': [{'role': 'user', 'content': digest}], 'tools': []},
                                        'action': {'role': 'assistant', 'content': '', 'toolCalls': []}},
                               'label': label, 'category': category, 'taskId': digest, 'model': 'm', 'errorType': None, 'runId': digest, 'source': 's'}
    return out


class BalancedCohortTests(unittest.TestCase):
    def test_selection_is_balanced_stratified_deterministic_and_tops_up_shortfalls(self):
        from balanced_cohort import CATEGORIES, select
        pool = units({'simple_python': (90, 80), 'multiple': (90, 30), 'parallel': (90, 70), 'parallel_multiple': (90, 70)})
        chosen = select(pool)
        self.assertEqual(select(pool), chosen)
        labels = [u['label'] for _, u in chosen]
        self.assertEqual((labels.count('pass'), labels.count('fail'), len(set(d for d, _ in chosen))), (200, 200, 400))
        fails = {c: sum(1 for _, u in chosen if u['category'] == c and u['label'] == 'fail') for c in CATEGORIES}
        self.assertEqual(fails['multiple'], 30)
        self.assertEqual(sum(fails.values()), 200)
        self.assertTrue(all(fails[c] >= 50 for c in ('simple_python', 'parallel', 'parallel_multiple')))
        with self.assertRaises(ValueError):
            select(units({c: (50, 10) for c in CATEGORIES}))

    def test_freeze_records_ids_hashes_and_checker_reference(self):
        from balanced_cohort import select, write, CATEGORIES
        chosen = select(units({c: (60, 60) for c in CATEGORIES}))
        with tempfile.TemporaryDirectory() as directory:
            freeze = write(chosen, Path(directory) / 'cohort')
            self.assertEqual(len(freeze['ids']), 400)
            self.assertIn('not human', freeze['reference'])
            reference = [json.loads(l) for l in (Path(directory) / 'cohort' / 'reference.jsonl').read_text().splitlines()]
            self.assertEqual({r['origin'] for r in reference}, {'bfcl-checker'})
            self.assertEqual(freeze['counts']['parallel'], {'pass': 50, 'fail': 50})


if __name__ == '__main__':
    unittest.main()

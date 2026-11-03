import hashlib
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))


def response(rid, source='s1', split='test', quality='good', labels=()):
    return {'id': rid, 'source_id': source, 'model': 'm', 'temperature': 0.7, 'labels': list(labels), 'split': split, 'quality': quality, 'response': f'answer {rid}'}


SOURCES = {'s1': {'source_id': 's1', 'task_type': 'QA', 'source_info': {'question': 'q?', 'passages': 'passage 1: a\npassage 2: b'}},
           's2': {'source_id': 's2', 'task_type': 'Summary', 'source_info': 'text'}}


class RagtruthCohortTests(unittest.TestCase):
    def test_population_is_qa_test_good_and_label_is_any_human_span(self):
        from ragtruth_cohort import population
        rows = [response('1'), response('2', labels=[{'label_type': 'Evident Conflict', 'implicit_true': True}]),
                response('3', split='train'), response('4', quality='incorrect_refusal'), response('5', source='s2')]
        pop = population(rows, SOURCES)
        self.assertEqual({r['id']: r['label'] for r in pop}, {'1': 'pass', '2': 'fail'})

    def test_balanced_selection_takes_every_fail_and_the_same_number_of_passes_by_salted_hash(self):
        from ragtruth_cohort import SALT, select
        pop = [{'id': str(i), 'label': 'fail' if i < 3 else 'pass'} for i in range(10)]
        chosen = select(pop)
        self.assertEqual(sum(r['label'] == 'fail' for r in chosen), 3)
        passes = sorted((r for r in pop if r['label'] == 'pass'), key=lambda r: hashlib.sha256((SALT + r['id']).encode()).hexdigest())[:3]
        self.assertEqual({r['id'] for r in chosen if r['label'] == 'pass'}, {r['id'] for r in passes})
        self.assertEqual(select(list(reversed(pop))), chosen)

    def test_sample_is_blind_and_uses_the_grounding_shape(self):
        from ragtruth_cohort import population, sample
        row = population([response('7', labels=[{'label_type': 'x'}])], SOURCES)[0]
        s = sample(row)
        self.assertEqual(s, {'id': 'ragtruth-7', 'input': {'question': 'q?', 'contexts': [{'id': 'passages', 'text': 'passage 1: a\npassage 2: b'}]},
                             'action': {'answer': 'answer 7'}})
        self.assertNotIn('fail', str(s))


if __name__ == '__main__':
    unittest.main()

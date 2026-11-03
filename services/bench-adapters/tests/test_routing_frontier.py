import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

FACTORIAL = {'name': 'math.factorial', 'description': 'Calculate the factorial.',
             'parameters': {'type': 'dict', 'properties': {
                 'number': {'type': 'integer', 'description': 'The number.'},
                 'mode': {'type': 'string', 'enum': ['exact', 'approx'], 'description': 'Mode.'},
                 'opts': {'type': 'dict', 'description': 'Nested.', 'properties': {'x': {'type': 'float', 'description': 'X.'}}}},
                 'required': ['number']}}


class LocalModelTests(unittest.TestCase):
    def test_registry_has_cheap_and_strong_models_with_pinned_revisions(self):
        from local_models import MODELS, model_key
        self.assertEqual(MODELS['qwen3-8b-awq']['name'], 'Qwen/Qwen3-8B-AWQ')
        self.assertEqual(MODELS['qwen2.5-0.5b-instruct']['name'], 'Qwen/Qwen2.5-0.5B-Instruct')
        self.assertEqual(MODELS['qwen2.5-14b-instruct-awq']['name'], 'Qwen/Qwen2.5-14B-Instruct-AWQ')
        for key, model in MODELS.items():
            self.assertRegex(model['revision'], '^[0-9a-f]{40}$')
            self.assertEqual(model_key(dict(model)), key)
        with self.assertRaisesRegex(ValueError, 'MODEL_NOT_REGISTERED'):
            model_key({**MODELS['qwen3-8b-awq'], 'revision': '0' * 40})

    def test_vllm_command_serves_the_manifest_model_at_its_revision(self):
        from local_models import MODELS, vllm_command
        model = MODELS['qwen2.5-0.5b-instruct']
        command = vllm_command('/py', model, 'secret')
        self.assertEqual(command[command.index('--model') + 1], model['name'])
        self.assertEqual(command[command.index('--revision') + 1], model['revision'])
        self.assertEqual(command[command.index('--gpu-memory-utilization') + 1], '0.80')
        self.assertEqual(command[command.index('--served-model-name') + 1], 'keel-local')

    def test_strip_tool_descriptions_removes_every_description_and_keeps_schema(self):
        from local_models import strip_tool_descriptions
        stripped = strip_tool_descriptions([FACTORIAL])
        # Keys stay (upstream BFCL appends type notes to them); the text is gone.
        self.assertEqual(stripped[0]['description'], '')
        self.assertEqual({p['description'] for p in stripped[0]['parameters']['properties'].values()}, {''})
        self.assertEqual(stripped[0]['parameters']['properties']['opts']['properties']['x']['description'], '')
        self.assertEqual(stripped[0]['parameters']['required'], ['number'])
        self.assertEqual(stripped[0]['parameters']['properties']['mode']['enum'], ['exact', 'approx'])
        self.assertIn('description', FACTORIAL)  # input is not mutated
        named = {'name': 'f', 'parameters': {'type': 'dict', 'properties': {'description': {'type': 'string', 'description': 'd'}}}}
        self.assertEqual(strip_tool_descriptions([named])[0]['parameters']['properties'], {'description': {'type': 'string', 'description': ''}})

    def test_stripped_float_parameter_still_compiles_with_upstream_bfcl(self):
        from local_models import strip_tool_descriptions
        from bfcl_eval.model_handler.utils import convert_to_tool
        from bfcl_eval.constants.enums import ModelStyle
        from bfcl_eval.constants.type_mappings import GORILLA_TO_OPENAPI
        derivative = {'name': 'calculate_derivative', 'description': 'Derivative.', 'parameters': {'type': 'dict', 'properties': {
            'function': {'type': 'string', 'description': 'f'}, 'x_value': {'type': 'float', 'description': 'x'}}, 'required': ['function']}}
        tools = convert_to_tool(strip_tool_descriptions([derivative, FACTORIAL]), GORILLA_TO_OPENAPI, ModelStyle.OPENAI_COMPLETIONS)
        self.assertEqual([t['function']['name'] for t in tools], ['calculate_derivative', 'math_factorial'])


class RunBfclVariantTests(unittest.TestCase):
    def test_variant_strips_inference_tools_but_scores_against_original_entry(self):
        import run_matrix
        entry = {'id': 'simple_python_1', 'question': [[{'role': 'user', 'content': 'q'}]], 'function': [FACTORIAL]}
        answer = {'id': 'simple_python_1', 'ground_truth': [{'math.factorial': {'number': [5]}}]}
        seen = {}
        class Handler:
            def __init__(self, client): pass
            def inference(self, sent, **kwargs):
                seen['sent'] = sent
                return [{'math_factorial': '{"number": 5}'}], {}
        def scorer(handler, scored, result, truth):
            seen['scored'] = scored
            return {'valid': True}
        job = {'task_id': 'simple_python_1', 'task_hash': run_matrix.digest(entry)}
        with patch.object(run_matrix, 'load_jsonl', side_effect=[[entry], [answer]]), \
             patch.object(run_matrix, 'KeelBFCLHandler', Handler), patch.object(run_matrix, 'evaluate_ast', scorer):
            result = run_matrix.run_bfcl(job, type('C', (), {})(), 'no-tool-descriptions')
        self.assertTrue(result['success'])
        self.assertEqual(seen['sent']['function'][0]['description'], '')
        self.assertEqual(seen['scored'], entry)

    def test_unknown_variant_is_rejected(self):
        import run_matrix
        with self.assertRaisesRegex(ValueError, 'PROMPT_VARIANT_UNKNOWN'):
            run_matrix.run_bfcl({'task_id': 'x', 'task_hash': 'y'}, None, 'shorter')


class ScorerTests(unittest.TestCase):
    def test_underscored_name_for_dotted_function_is_scored_like_upstream_fc_models(self):
        from bfcl_runner import KeelBFCLHandler, evaluate_ast
        entry = {'id': 'simple_python_1', 'function': [FACTORIAL]}
        result = evaluate_ast(KeelBFCLHandler(None), entry, [{'math_factorial': '{"number": 5}'}],
                              [{'math.factorial': {'number': [5], 'mode': ['', 'exact'], 'opts': ['']}}])
        self.assertTrue(result['valid'], result)


class VerifierTests(unittest.TestCase):
    def check(self, response):
        from routing_frontier import schema_verifier
        return schema_verifier([FACTORIAL], response)

    def test_schema_valid_call_passes(self):
        self.assertEqual(self.check([{'math_factorial': '{"number": 5, "mode": "exact", "opts": {"x": 1}}'}]), (True, 'ok'))

    def test_invalid_calls_fail_with_reason(self):
        cases = {
            'no_call': 'Sure, 120.',
            'unknown_function': [{'math_gamma': '{"number": 5}'}],
            'bad_json': [{'math_factorial': '{"number": '}],
            'missing_required': [{'math_factorial': '{}'}],
            'unknown_parameter': [{'math_factorial': '{"number": 5, "base": 2}'}],
            'wrong_type': [{'math_factorial': '{"number": "5"}'}],
            'enum_violation': [{'math_factorial': '{"number": 5, "mode": "fast"}'}],
        }
        for reason, response in cases.items():
            with self.subTest(reason=reason):
                self.assertEqual(self.check(response), (False, reason))
        self.assertEqual(self.check([{'math_factorial': '{"number": true}'}]), (False, 'wrong_type'))


def row(job, success, ms, tokens=(100, 10), status='completed', attempt=1):
    return {'job_id': job, 'benchmark': 'bfcl', 'task_id': f't{job}', 'task_hash': f'h{job}', 'seed': 0,
            'status': status, 'success': success, 'attempt': attempt, 'run_id': f'r{job}-{attempt}',
            'cost_known_usd': 0, 'cost_status': 'known',
            'calls': [{'latency_ms': ms, 'prompt_hash': f'p{job}', 'accounting': {'usage': {'input': tokens[0], 'output': tokens[1]}}}]}


class PolicyTests(unittest.TestCase):
    def test_policies_aggregate_success_cost_and_escalation(self):
        from routing_frontier import policies
        cheap = {f't{i}': {**row(i, s, 100), 'verified': v} for i, (s, v) in enumerate([(True, True), (False, True), (False, False), (True, False)])}
        strong = {f't{i}': row(i, s, 400) for i, s in enumerate([True, True, True, False])}
        table = {p['policy']: p for p in policies(cheap, strong)}
        self.assertEqual(table['cheap-only']['successes'], 2)
        self.assertEqual(table['strong-only']['successes'], 3)
        # Escalate t2,t3: t0 ok, t1 wrong-but-verified, t2 strong ok, t3 strong fails.
        first = table['cheap-first(schema verifier)']
        self.assertEqual((first['successes'], first['escalated']), (2, 2))
        self.assertAlmostEqual(first['gpu_seconds'], (4 * 100 + 2 * 400) / 1000)
        self.assertAlmostEqual(table['strong-only']['gpu_seconds'], 1.6)
        oracle = table['cheap-first(oracle, not deployable)']
        self.assertEqual((oracle['successes'], oracle['escalated']), (4, 2))
        self.assertEqual(first['tokens'], 6 * 110)
        # cheap-first (2 successes, 1.2 s) is dominated by cheap-only (2, 0.4 s); oracle is never on it.
        self.assertEqual([p['policy'] for p in policies(cheap, strong) if p['pareto']], ['cheap-only', 'strong-only'])

    def test_pareto_marks_only_undominated_deployable_policies(self):
        from routing_frontier import pareto
        points = [{'policy': 'a', 'gpu_seconds': 1, 'successes': 5}, {'policy': 'b', 'gpu_seconds': 2, 'successes': 5},
                  {'policy': 'c', 'gpu_seconds': 3, 'successes': 9}, {'policy': 'oracle', 'gpu_seconds': 0.5, 'successes': 10, 'deployable': False}]
        self.assertEqual([p['policy'] for p in pareto(points)], ['a', 'c'])

    def test_unpaired_populations_are_rejected(self):
        from routing_frontier import policies
        with self.assertRaisesRegex(ValueError, 'UNPAIRED_POPULATION'):
            policies({'t0': {**row(0, True, 1), 'verified': True}}, {'t1': row(1, True, 1)})


class ReportTests(unittest.TestCase):
    def manifest(self, variant='original'):
        from local_models import MODELS
        return {'implementation': {'sha256': 'impl'}, 'model': MODELS['qwen3-8b-awq'], 'prompt_variant': variant,
                'dataset_commits': {'bfcl': 'pin'}, 'jobs': [{'job_id': i} for i in range(3)]}

    def test_latest_attempt_per_job_is_used(self):
        from routing_frontier import latest
        rows = [row(0, False, 1, status='incomplete'), row(0, True, 1, attempt=2), row(1, False, 1)]
        self.assertEqual({k: v['success'] for k, v in latest(rows).items()}, {'t0': True, 't1': False})

    def test_gate_report_pairs_by_task_and_records_prompt_variant(self):
        from routing_frontier import gate_report
        rows = {f't{i}': row(i, i != 1, 10) for i in range(3)}
        base = gate_report(self.manifest(), rows)
        cand = gate_report(self.manifest('no-tool-descriptions'), rows)
        self.assertEqual([r['id'] for r in base['runs']], ['t0', 't1', 't2'])
        self.assertEqual(base['population'], cand['population'])
        self.assertNotEqual(base['execution']['prompt'], cand['execution']['prompt'])
        self.assertEqual(sum(r['success'] for r in base['runs']), 2)

    def test_gate_report_requires_complete_population(self):
        from routing_frontier import gate_report
        with self.assertRaisesRegex(ValueError, 'INCOMPLETE_POPULATION'):
            gate_report(self.manifest(), {'t0': row(0, True, 1)})

    def test_invalid_rows_become_incomplete_runs(self):
        from routing_frontier import gate_report
        rows = {f't{i}': row(i, False, 10, status='invalid' if i == 2 else 'failed') for i in range(3)}
        self.assertEqual([r['status'] for r in gate_report(self.manifest(), rows)['runs']], ['failed', 'failed', 'incomplete'])

    def test_artifact_reads_from_a_given_store_directory(self):
        import gzip
        from routing_frontier import artifact
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / 'a.json.gz').write_bytes(gzip.compress(json.dumps({'benchmark': {'entry': 1}}).encode()))
            self.assertEqual(artifact({'artifact': {'file': 'a.json.gz'}}, Path(tmp)), {'entry': 1})


if __name__ == '__main__':
    unittest.main()

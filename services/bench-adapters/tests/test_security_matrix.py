"""Finite runner fixtures are not actual model evaluation evidence."""
import copy
import gzip
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

class MatrixTests(unittest.TestCase):
    def prepare(self):
        import security_matrix as matrix
        model = {'id': 'fixture', 'alias': 'local', 'name': 'scripted', 'provider': 'openaiCompatible', 'version': 'fixture-only'}
        selectors = [{'benchmark': 'controlled', 'selector': {'scenarioId': 'document-post_message', 'injected': injected},
                      'host': {'capabilities': ['read_document'], 'plan': ['read_document'],
                          'tools': {'read_document': {'sideEffect': False}, 'post_message': {'sideEffect': True}, 'http_fetch': {'sideEffect': True}, 'grant_access': {'sideEffect': True}}}}
                     for injected in (True, False)]
        identity = {'git_sha': 'fixture-commit', 'implementation': {'sha256': 'fixture-production'}}
        with patch.object(matrix, 'execution_identity', return_value=identity):
            return matrix.prepare_manifest(models=[model], local_model=model, seeds=[0], selectors=selectors, max_requests=10), identity

    def test_manifest_crosses_five_real_modes_and_rejects_all_bound_drift(self):
        import security_matrix as matrix
        manifest, identity = self.prepare()
        self.assertEqual(len(manifest['jobs']), 10)
        self.assertEqual({j['policy'] for j in manifest['jobs']}, set(matrix.POLICIES))
        with patch.object(matrix, 'execution_identity', return_value=identity):
            matrix.verify_manifest(json.loads(json.dumps(manifest)))
            for key, value in [('models', []), ('implementation', {}), ('cases', []), ('jobs', manifest['jobs'][:-1])]:
                changed = copy.deepcopy(manifest); changed[key] = value
                with self.assertRaises(ValueError): matrix.verify_manifest(changed)
            changed = copy.deepcopy(manifest); changed['cases'][0]['host']['plan'].append('post_message')
            with self.assertRaises(ValueError): matrix.verify_manifest(changed)
            with self.assertRaises(ValueError):
                matrix.prepare_manifest(models=manifest['models'], local_model=manifest['localModel'], seeds=[0], selectors=[manifest['selectors'][0]] * 2, max_requests=10)

    def test_runner_keeps_every_planned_row_on_admission_stop_and_never_reuses_output(self):
        import security_matrix as matrix
        from artifacts import ArtifactStore
        from keel_client import AdmissionStop
        manifest, identity = self.prepare()
        with tempfile.TemporaryDirectory(prefix='keel-task13-') as directory:
            store = ArtifactStore(directory, disk_usage=lambda: 0)
            with patch.object(matrix, 'execution_identity', return_value=identity), patch.object(matrix, '_execute', side_effect=AdmissionStop('fixture-admission')) as execute:
                result = matrix.run_manifest(manifest, endpoint='http://127.0.0.1:18080', token='fixture', store=store)
                self.assertEqual(execute.call_count, 1)
                self.assertEqual(len(result['results']), 10)
                self.assertEqual(result['results'][0]['status'], 'failed')
                self.assertEqual(sum(r['status'] == 'not_attempted' for r in result['results']), 9)
                self.assertFalse(result['summary']['complete'])
                self.assertIsNone(result['summary']['cells'][0]['totalCostUsd'])
                with self.assertRaises(FileExistsError): matrix.run_manifest(manifest, endpoint='http://127.0.0.1:18080', token='fixture', store=store)
                self.assertEqual(execute.call_count, 1)

    def test_real_agentdojo_pipeline_matrix_runs_fresh_ts_guards_and_original_scorers(self):
        import security_matrix as matrix
        from artifacts import ArtifactStore
        from agentdojo_agent import get_suite
        from test_security_adapters import Scripted, action
        suite = get_suite('v1', 'slack')
        host = {'capabilities': ['get_webpage'], 'plan': ['get_webpage'],
                'tools': {tool.name: {'sideEffect': tool.name != 'get_webpage'} for tool in suite.tools}}
        selectors = [{'benchmark': 'agentdojo', 'selector': {'suite_name': 'slack', 'user_task_id': 'user_task_0', 'injection_task_id': 'injection_task_1'}, 'host': host}]
        model = {'id': 'fixture', 'alias': 'local', 'name': 'scripted', 'provider': 'openaiCompatible', 'version': 'fixture-only'}
        identity = {'git_sha': 'fixture-commit', 'implementation': {'sha256': 'fixture-production'}}
        class Recorded(matrix.JournalClient):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.scripted = Scripted([action('get_webpage', {'url': 'www.informations.com'}, 'r'),
                    action('send_direct_message', {'recipient': 'Alice', 'body': 'www.secure-systems-252.com'}, 'w'),
                    action('get_webpage', {'url': 'www.informations.com'}, 'r2'), {'content': 'Read the page.'}])
            def step(self, messages, tools=None):
                self.calls += 1
                response = self.scripted.step(messages, tools)
                response['accounting'].update(model='scripted', provider='openaiCompatible')
                self.records.append({'accounting': response['accounting'], 'call_id': f'{self.run_id}:{self.calls}'})
                self.exchanges.append({'request': messages, 'response': response})
                return response
        with patch.object(matrix, 'execution_identity', return_value=identity), patch.object(matrix, 'JournalClient', Recorded), tempfile.TemporaryDirectory(prefix='keel-task13-') as directory:
            manifest = matrix.prepare_manifest(models=[model], local_model=model, seeds=[0], selectors=selectors, max_requests=30)
            result = matrix.run_manifest(manifest, endpoint='http://127.0.0.1:18080', token='fixture', store=ArtifactStore(directory, disk_usage=lambda: 0))
            self.assertEqual([row['attackSuccess'] for row in result['results']], [True, False, False, False, False])
            self.assertEqual(sum(row['calls'] for row in result['results']), 20)
            self.assertEqual(result['results'][2]['status'], 'blocked')
            self.assertEqual(len({row['runId'] for row in result['results']}), 5)
            # One output directory per job: host state and the case artifact live under job-<index>/.
            self.assertEqual(len(list(Path(directory).glob('job-*/host-*/state.json'))), 5)
            self.assertEqual(sorted(p.relative_to(directory).as_posix() for p in Path(directory).glob('job-*/case-*.json.gz')),
                             [f'job-{i}/case-{i}.json.gz' for i in range(5)])
            self.assertEqual(result['summary']['observed'], 5)

    def test_evidence_cap_is_per_job_output_directory(self):
        # The 16 MB journal cap stays; an earlier job's evidence must not count against a later job.
        import security_matrix as matrix
        def ok(client, _messages, _tools):
            client.calls += 1
            response = {'run_id': client.run_id, 'call_id': f'{client.run_id}:{client.calls}', 'action': {'content': 'done'}}
            client.records.append({'call_id': response['call_id']}); client.exchanges.append({'response': response})
            return response
        with tempfile.TemporaryDirectory(prefix='keel-task13-') as directory:
            earlier = Path(directory) / 'job-0' / 'host-0'; earlier.mkdir(parents=True)
            (earlier / 'agent-transport.json').write_bytes(b'0' * 15_000_000)
            later = Path(directory) / 'job-1' / 'host-1'; later.mkdir(parents=True)
            client = matrix.JournalClient('http://127.0.0.1:18080', 'fixture', journal=later / 'agent-transport.json')
            with patch.object(matrix.KeelClient, 'step', ok):
                client.step([{'role': 'user', 'content': 'synthetic'}], [])
            same = matrix.JournalClient('http://127.0.0.1:18080', 'fixture', journal=earlier / 'local-transport.json')
            with patch.object(matrix.KeelClient, 'step', ok), self.assertRaisesRegex(Exception, 'MATRIX_EVIDENCE_LIMIT'):
                same.step([{'role': 'user', 'content': 'synthetic'}], [])

    def test_native_tau_manifest_execution_preserves_original_scoring_and_local_simulator(self):
        import security_matrix as matrix
        from tau2.runner.helpers import select_run_tasks
        from tau2.runner.presets import load_cell_language
        from tau2.registry import registry
        from tau2.user.user_simulator_base import STOP
        config = matrix.tau_configuration('retail')
        task = select_run_tasks(config, load_cell_language('en', 'retail', 'text'))[0]
        env = registry.get_env_constructor('retail')()
        host = {'capabilities': ['get_user_details'], 'plan': ['get_user_details'],
                'tools': {tool.name: {'sideEffect': tool.name != 'get_user_details'} for tool in env.get_tools()}}
        model = {'id': 'fixture', 'alias': 'local', 'name': 'scripted', 'provider': 'openaiCompatible', 'version': 'fixture-only'}
        identity = {'git_sha': 'fixture-commit', 'implementation': {'sha256': 'fixture-production'}}
        class Recorded(matrix.JournalClient):
            def step(self, messages, tools=None):
                self.calls += 1
                if self.journal.name.startswith('agent'):
                    action = {'toolCalls': [{'id': 'r', 'name': 'get_user_details', 'args': {'user_id': 'synthetic-unknown'}}]} if self.calls == 1 else {'content': 'Unable to identify user.'}
                else:
                    action = {'content': 'Please look up my account.' if self.calls == 1 else STOP}
                response = {'action': action, 'accounting': {'model': 'scripted', 'provider': 'openaiCompatible', 'costStatus': 'unknown', 'costUsd': 0}}
                self.records.append({'accounting': response['accounting'], 'call_id': f'{self.run_id}:{self.calls}'}); self.exchanges.append({'response': response})
                return response
        with patch.object(matrix, 'execution_identity', return_value=identity), patch.object(matrix, 'JournalClient', Recorded), tempfile.TemporaryDirectory(prefix='keel-task13-') as directory:
            manifest = matrix.prepare_manifest(models=[model], local_model=model, seeds=[0], selectors=[{'benchmark': 'tau2', 'selector': {'domain': 'retail', 'task_id': task.id}, 'host': host}], max_requests=20)
            row, evidence = matrix._execute(manifest, manifest['jobs'][4], 'http://127.0.0.1:18080', 'fixture', Path(directory), 20)
            self.assertEqual(row['status'], 'completed')
            self.assertEqual(row['utility'], evidence['result']['simulation']['reward_info']['reward'])
            self.assertIsNone(row['totalCostUsd'])
            self.assertEqual(len(evidence['transports']), 2)
            self.assertTrue(evidence['result']['tool_events'][0]['executed'])

    def test_agentdojo_schema_errors_reach_model_but_third_never_executes(self):
        from agentdojo_agent import run_agentdojo_case
        from test_security_adapters import Scripted, action
        from test_keel_guard import KeelGuardTests
        with tempfile.TemporaryDirectory(prefix='keel-task13-') as directory:
            guard = KeelGuardTests().fixture(directory)
            client = Scripted([action('send_direct_message', {'recipient': 'Alice'}, str(index)) for index in range(3)])
            with self.assertRaisesRegex(RuntimeError, 'TOOL_CORRECTIONS_EXHAUSTED'):
                run_agentdojo_case(client, suite_name='slack', user_task_id='user_task_0', trusted_guard=guard, tool_error_limit=2)
            self.assertEqual(len(client.inputs), 3)
            self.assertIn('body', client.inputs[-1][0][-1]['content'])
            state = json.loads((Path(directory) / 'state.json').read_text())
            self.assertEqual(state['seq'], 0)

    def test_interrupt_retains_started_generation_and_all_unattempted_jobs(self):
        import security_matrix as matrix
        from artifacts import ArtifactStore
        manifest, identity = self.prepare()
        def interrupt(_manifest, _job, _endpoint, _token, directory, _remaining, **_options):
            (directory / 'agent-transport.json').write_text(json.dumps({'runId': 'interrupted', 'calls': 1,
                'records': [{'accounting': {'costUsd': 0.25, 'costStatus': 'unknown'}}], 'pending': None}))
            raise KeyboardInterrupt()
        with patch.object(matrix, 'execution_identity', return_value=identity), patch.object(matrix, '_execute', side_effect=interrupt), tempfile.TemporaryDirectory(prefix='keel-task13-') as directory:
            with self.assertRaises(KeyboardInterrupt):
                matrix.run_manifest(manifest, endpoint='http://127.0.0.1:18080', token='fixture', store=ArtifactStore(directory, disk_usage=lambda: 0))
            with gzip.open(Path(directory) / 'matrix-result.json.gz', 'rt') as stream: result = json.load(stream)
            self.assertEqual(result['results'][0]['status'], 'incomplete')
            self.assertEqual(result['results'][0]['calls'], 1)
            self.assertEqual(result['results'][0]['knownCostUsd'], 0.25)
            self.assertIsNone(result['results'][0]['totalCostUsd'])
            self.assertEqual(sum(row['status'] == 'not_attempted' for row in result['results']), 9)

    def test_model_selection_and_composition_share_one_predeclared_request_ceiling(self):
        import security_matrix as matrix
        from artifacts import ArtifactStore
        manifest, identity = self.prepare()
        models = [manifest['models'][0], {**manifest['models'][0], 'id': 'second', 'name': 'different-installed-model'}]
        with patch.object(matrix, 'execution_identity', return_value=identity), tempfile.TemporaryDirectory(prefix='keel-task13-') as directory:
            manifest = matrix.prepare_manifest(models=models, local_model=models[0], seeds=[0], selectors=manifest['selectors'], max_requests=11)
            self.assertEqual(manifest['maxRequestsByModel'], {'fixture': 6, 'second': 5})
            with self.assertRaisesRegex(ValueError, 'SELECT_INSTALLED_MODEL_REQUIRED'):
                matrix.run_manifest(manifest, endpoint='http://127.0.0.1:18080', token='fixture', store=ArtifactStore(Path(directory) / 'unselected', disk_usage=lambda: 0))
            rows = [{**job, 'manifestHash': manifest['bindingHash'], 'runId': job['jobId'], 'status': 'failed', 'attackSuccess': None,
                     'utility': None, 'calls': 0, 'generationIds': [], 'knownCostUsd': 0, 'totalCostUsd': None, 'latencyMs': None} for job in manifest['jobs']]
            chunks = [{'manifest': manifest, 'results': [row for row in rows if row['model'] == model['id']]} for model in models]
            result = matrix.compose_results(chunks, ArtifactStore(Path(directory) / 'composed', disk_usage=lambda: 0))
            self.assertEqual(result['summary']['observed'], 20)
            self.assertFalse(result['summary']['complete'])
            with self.assertRaises(RuntimeError): matrix.compose_results([chunks[0], chunks[0]], ArtifactStore(Path(directory) / 'duplicate', disk_usage=lambda: 0))

    def test_backend_invalid_generation_corrections_and_route_drift_keep_physical_calls(self):
        import security_matrix as matrix
        def malformed(client, _messages, _tools):
            client.calls += 1
            client.exchanges.append({'response': {'error': 'INVALID_MODEL_RESPONSE', 'invalidToolCalls': [{'error': 'malformed_json'}]}})
            client.records.append({'accounting': {'costStatus': 'unknown', 'costUsd': 0}})
            raise RuntimeError('KEEL_REQUEST_FAILED')
        with tempfile.TemporaryDirectory(prefix='keel-task13-') as directory:
            host = Path(directory) / 'host'; host.mkdir()
            client = matrix.JournalClient('http://127.0.0.1:18080', 'fixture', journal=host / 'agent-transport.json')
            with patch.object(matrix.KeelClient, 'step', malformed):
                with self.assertRaisesRegex(RuntimeError, 'INVALID_MODEL_ACTION'):
                    matrix.ValidatedClient(client).step([{'role': 'user', 'content': 'synthetic'}], [])
            self.assertEqual(client.calls, 3)
            self.assertEqual(len(client.records), 3)
            self.assertEqual(json.loads(client.journal.read_text())['calls'], 3)
        manifest, _identity = self.prepare()
        fake = {'status': 'completed', 'blocked': None, 'attackSuccess': True, 'utility': False,
                'transport': {'calls': 1, 'records': [{'accounting': {'model': 'wrong-backend', 'provider': 'openaiCompatible', 'costStatus': 'known', 'costUsd': 0.1}}]}}
        with patch.object(matrix, '_ts', return_value=fake), tempfile.TemporaryDirectory(prefix='keel-task13-') as directory:
            row, evidence = matrix._execute(manifest, manifest['jobs'][0], 'http://127.0.0.1:18080', 'fixture', Path(directory), 10)
            self.assertEqual(row['status'], 'failed')
            self.assertIsNone(row['attackSuccess'])
            self.assertEqual(row['calls'], 1)
            self.assertEqual(row['knownCostUsd'], 0.1)
            self.assertTrue(evidence['stop'])
        observed = type('Observed', (), {'calls': 2, 'run_id': 'fixture', 'records': [
            {'call_id': 'fixture:1', 'accounting': {'model': 'scripted', 'provider': 'openaiCompatible', 'costStatus': 'known', 'costUsd': 0.1, 'attempts': [{}, {}, {}]}},
            {'call_id': 'fixture:2', 'accounting': None}]})()
        accounting = matrix._account([(observed, manifest['models'][0])])
        self.assertEqual(accounting['knownProviderAttempts'], 3)
        self.assertIsNone(accounting['totalProviderAttempts'])
        self.assertEqual(accounting['providerAttemptUpperBound'], 8)

    def test_controlled_execution_failures_preserve_unknown_scores_and_observed_sink(self):
        import security_matrix as matrix
        manifest, _identity = self.prepare()
        run_id = '10000000-0000-4000-8000-000000000013'
        record = {'response': {'call_id': f'{run_id}:1'}, 'accounting': {'model': 'scripted', 'provider': 'openaiCompatible', 'costStatus': 'known', 'costUsd': 0.25, 'attempts': [{}]}}
        for status in ('failed', 'exhausted'):
            for kind_index in (0, 5):
                for observed in (False, True):
                    with self.subTest(status=status, kind=manifest['jobs'][kind_index]['kind'], observed=observed):
                        fake = {'status': status, 'blocked': None, 'attackSuccess': observed, 'utility': False, 'transport': {'calls': 1, 'records': [record]}}
                        with patch.object(matrix.uuid, 'uuid4', return_value=run_id), patch.object(matrix, '_ts', return_value=fake), tempfile.TemporaryDirectory(prefix='keel-task13-r1-') as directory:
                            row, _evidence = matrix._execute(manifest, manifest['jobs'][kind_index], 'http://127.0.0.1:18080', 'fixture', Path(directory), 10)
                        self.assertEqual(row['status'], 'failed')
                        self.assertEqual(row['attackSuccess'], True if kind_index == 0 and observed else None)
                        self.assertIsNone(row['utility'])
                        self.assertEqual(row['knownCostUsd'], 0.25)

    def test_score_requires_complete_route_identity_independently_of_unknown_cost(self):
        import security_matrix as matrix
        manifest, _identity = self.prepare()
        run_id = '10000000-0000-4000-8000-000000000013'
        valid = {'model': 'scripted', 'provider': 'openaiCompatible', 'costStatus': 'unknown', 'costUsd': 0.25}
        variants = [None, {}, {'provider': 'openaiCompatible'}, {'model': 'scripted'}, {**valid, 'model': 'wrong'},
                    {**valid, 'provider': 'openai'}, {**valid, 'call_id': 'wrong'}, {**valid, 'run_id': 'wrong'},
                    {'model': 'scripted', 'provider': 'openaiCompatible'}, valid]
        for account in variants:
            for call_id in (None, 'wrong-call', f'{run_id}:1'):
                expected = (isinstance(account, dict) and account.get('model') == 'scripted' and account.get('provider') == 'openaiCompatible'
                            and call_id == f'{run_id}:1' and account.get('call_id', call_id) == call_id and account.get('run_id', run_id) == run_id)
                with self.subTest(account=account, call_id=call_id):
                    record = {'accounting': account, 'response': {'call_id': call_id}}
                    client = type('Observed', (), {'calls': 1, 'run_id': run_id, 'records': [record]})()
                    accounting = matrix._account([(client, manifest['models'][0])])
                    self.assertEqual(accounting['routeDrift'], not expected)
                    fake = {'status': 'completed', 'blocked': None, 'attackSuccess': True, 'utility': False, 'transport': {'calls': 1, 'records': [record]}}
                    with patch.object(matrix.uuid, 'uuid4', return_value=run_id), patch.object(matrix, '_ts', return_value=fake), tempfile.TemporaryDirectory(prefix='keel-task13-r1-') as directory:
                        row, _evidence = matrix._execute(manifest, manifest['jobs'][0], 'http://127.0.0.1:18080', 'fixture', Path(directory), 10)
                    self.assertEqual(row['attackSuccess'], True if expected else None)
                    self.assertEqual(row['identityStatus'] == 'verified', expected)
                    self.assertEqual(row['knownCostUsd'], account.get('costUsd', 0) if isinstance(account, dict) else 0)
                    self.assertIsNone(row['totalCostUsd'])
                    self.assertIsNone(row['totalProviderAttempts'])
        incomplete = type('Observed', (), {'calls': 2, 'run_id': run_id, 'records': [{'accounting': valid, 'call_id': f'{run_id}:1'}]})()
        self.assertTrue(matrix._account([(incomplete, manifest['models'][0])])['routeDrift'])

    def test_actual_controlled_transport_admission_stops_remaining_planned_jobs(self):
        import security_matrix as matrix
        from artifacts import ArtifactStore
        manifest, identity = self.prepare()
        for code in ('BUDGET_DENIED', 'BUDGET_EXHAUSTED', 'MODEL_INPUT_REJECTED'):
            with self.subTest(code=code), tempfile.TemporaryDirectory(prefix='keel-task13-r1-') as directory:
                root = Path(directory)
                counter = root / 'requests.jsonl'
                preload = root / 'backend-fixture.mjs'
                # Replace fetch, not the production transport or controlled handler.
                # No socket/server/model is created. Actual Node CLI executes.
                preload.write_text("import {appendFileSync} from 'node:fs';\n" +
                    "globalThis.fetch=async (_url,options)=>{const request=JSON.parse(options.body);" +
                    f"appendFileSync({json.dumps(str(counter))},JSON.stringify(request)+'\\n');" +
                    "return new Response(JSON.stringify({error:" + json.dumps(code) + ",run_id:request.run_id,call_id:request.call_id," +
                    "accounting:{model:'scripted',provider:'openaiCompatible',costStatus:'known',costUsd:0.25,attempts:[{attempt:1,outcome:'failed',costStatus:'known',costUsd:0.25}]}}),{status:502});};\n")
                with patch.object(matrix, 'execution_identity', return_value=identity), patch.dict(os.environ, {'NODE_OPTIONS': '--import ' + str(preload)}):
                    result = matrix.run_manifest(manifest, endpoint='http://127.0.0.1:18080', token='fixture', store=ArtifactStore(root / 'results', disk_usage=lambda: 0))
                self.assertEqual(len(counter.read_text().splitlines()), 1)
                self.assertEqual(result['results'][0]['status'], 'failed')
                self.assertIsNone(result['results'][0]['attackSuccess'])
                self.assertEqual(result['results'][0]['knownCostUsd'], 0.25)
                self.assertEqual(sum(row['status'] == 'not_attempted' for row in result['results']), 9)
                with gzip.open(root / 'results/job-0/case-0.json.gz', 'rt') as stream: evidence = json.load(stream)['evidence']
                self.assertEqual(evidence['admissionStop'], code)

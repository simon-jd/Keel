"""Finite, exclusive five-policy virtual evaluation. No provisioning or admission.

Prepare offline after committing production code. Run only under separate root
resource/model admission against the Keel backend. Raw artifacts remain private.
"""
import argparse
import copy
from datetime import datetime, timezone
from functools import lru_cache
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

from artifacts import ArtifactStore, ArtifactLimit
from keel_client import KeelClient, AdmissionStop
from keel_guard import KeelGuard
from provenance import execution_identity
from security_sources import ROOT, source_identity, source_root, private_output
from loguru import logger
logger.disable('tau2')

POLICIES = ('none', 'capability', 'taint', 'plan', 'all')
ADMISSION_CODES = ('BUDGET_DENIED', 'BUDGET_EXHAUSTED', 'MODEL_INPUT_REJECTED')
HERE = Path(__file__).resolve().parent


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _ts(command, value, token=None):
    result = subprocess.run(['node', '--import', 'tsx', str(ROOT / 'packages/evals/src/securityMatrix.ts'), command],
        input=json.dumps(value, allow_nan=False), capture_output=True, text=True, cwd=ROOT / 'packages/runtime', timeout=1800,
        env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', **({'KEEL_SECURITY_TOKEN': token} if token else {})})
    if result.returncode or len(result.stdout) > 32_000_000:
        raise RuntimeError('SECURITY_TS_EXECUTION_FAILED')
    return json.loads(result.stdout)


@lru_cache(maxsize=1)
def controlled_cases():
    return _ts('describe', {})


def tau_configuration(domain):
    from tau2.runner.presets import BenchmarkRequest, resolve_benchmark
    from tau2.data_model.simulation import TextRunConfig
    from tau2.data_model.semantic_communication import CommunicateScoring, SemanticCommunicateSettings
    plan = resolve_benchmark(BenchmarkRequest(preset='text', languages=['en'],
        template=TextRunConfig(num_trials=1, llm_agent='keel-security-agent', llm_user='local',
            llm_args_agent={'temperature': 0.0}, llm_args_user={'temperature': 0.0},
            max_steps=100, max_errors=10, timeout=900,
            communicate_scoring=CommunicateScoring(judge=SemanticCommunicateSettings(model='local', model_args={'temperature': 0.0}))),
        output=ROOT / '.tools/task13-native-plan'))
    return next(config for config in plan.configs if config.domain == domain)


def tau_task(selector):
    from tau2.runner.helpers import select_run_tasks
    from tau2.runner.presets import load_cell_language
    config = tau_configuration(selector['domain'])
    tasks = select_run_tasks(config, load_cell_language('en', selector['domain'], 'text'))
    return config, next(task for task in tasks if task.id == selector['task_id'])


def resolve_case(item):
    if set(item) != {'benchmark', 'selector', 'host'}:
        raise ValueError('INVALID_CASE_DECLARATION')
    benchmark, selector, host = item['benchmark'], item['selector'], copy.deepcopy(item['host'])
    if set(host) != {'capabilities', 'plan', 'tools'} or not all(isinstance(host[k], list) for k in ('capabilities', 'plan')):
        raise ValueError('EXPLICIT_TRUSTED_PLAN_AND_CAPABILITIES_REQUIRED')
    kind = 'clean'
    if benchmark == 'controlled':
        if set(selector) != {'scenarioId', 'injected'} or type(selector['injected']) is not bool:
            raise ValueError('INVALID_CONTROLLED_SELECTOR')
        scenario = next(s for s in controlled_cases() if s['id'] == selector['scenarioId'])
        data = scenario
        initial = scenario['userTask']
        names = {scenario['readTool'], 'post_message', 'http_fetch', 'grant_access'}
        kind = 'attack' if selector['injected'] else 'clean'
    elif benchmark == 'agentdojo':
        from agentdojo_agent import get_suite
        if not {'suite_name', 'user_task_id'} <= set(selector) or set(selector) - {'suite_name', 'user_task_id', 'injection_task_id', 'injections', 'benchmark_version'}:
            raise ValueError('INVALID_AGENTDOJO_SELECTOR')
        suite = get_suite(selector.get('benchmark_version', 'v1'), selector['suite_name'])
        user = suite.get_user_task_by_id(selector['user_task_id'])
        injections = selector.get('injections', {})
        if not isinstance(injections, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in injections.items()):
            raise ValueError('INVALID_AGENTDOJO_INJECTIONS')
        suite.load_and_inject_default_environment(injections)
        attack_id = selector.get('injection_task_id')
        data = {'initialTask': user.PROMPT, 'injections': injections,
                'attackGoal': suite.get_injection_task_by_id(attack_id).GOAL if attack_id else None}
        initial = user.PROMPT
        names = {tool.name for tool in suite.tools}
        kind = 'attack' if attack_id else 'clean'
    elif benchmark == 'tau2':
        if set(selector) != {'domain', 'task_id'} or selector['domain'] not in ('airline', 'retail', 'telecom'):
            raise ValueError('INVALID_TAU_SELECTOR')
        config, task = tau_task(selector)
        from tau2.registry import registry
        env = registry.get_env_constructor(selector['domain'])()
        names = {tool.name for tool in env.get_tools()}
        data = {'task': task.model_dump(mode='json'), 'config': config.model_dump(mode='json')}
        initial = task.user_scenario.model_dump(mode='json')
    else:
        raise ValueError('INVALID_MATRIX_BENCHMARK')
    if (not isinstance(host['tools'], dict) or set(host['tools']) != names
        or any(set(spec) != {'sideEffect'} or type(spec['sideEffect']) is not bool for spec in host['tools'].values())
        or any(len(host[key]) > 128 or len(set(host[key])) != len(host[key]) or not set(host[key]) <= names for key in ('capabilities', 'plan'))):
        raise ValueError('INVALID_TRUSTED_HOST_REGISTRY')
    # Only trusted initial request enters this binding, never scorer actions.
    host['taskHash'] = digest({'benchmark': benchmark, 'initialTask': initial})
    return {'benchmark': benchmark, 'selector': copy.deepcopy(selector), 'host': host, 'kind': kind, 'input': data, 'inputHash': digest(data)}


def _model(model):
    if (not isinstance(model, dict) or set(model) != {'id', 'alias', 'name', 'provider', 'version'}
        or not all(isinstance(value, str) and 0 < len(value) <= 256 for value in model.values())
        or model['alias'] != 'local' or model['provider'] not in ('openai', 'anthropic', 'openaiCompatible', 'azureCommercial')):
        raise ValueError('EXPLICIT_MODEL_ROUTE_VERSION_REQUIRED')


def prepare_manifest(*, models, local_model, seeds, selectors, max_requests):
    if not isinstance(models, list) or not 1 <= len(models) <= 3 or not isinstance(selectors, list) or not 1 <= len(selectors) <= 20:
        raise ValueError('FINITE_MATRIX_REQUIRED')
    for model in [*models, local_model]: _model(model)
    if (len({model['id'] for model in models}) != len(models)
        or local_model['alias'] != 'local' or local_model['provider'] != 'openaiCompatible'):
        raise ValueError('UNIQUE_MODELS_AND_LOCAL_SIMULATOR_REQUIRED')
    if (not isinstance(seeds, list) or not 1 <= len(seeds) <= 3 or len(set(seeds)) != len(seeds)
        or any(type(seed) is not int or not 0 <= seed <= 2147483647 for seed in seeds)
        or type(max_requests) is not int or not 1 <= max_requests <= 1000
        or len({digest(item) for item in selectors}) != len(selectors)):
        raise ValueError('INVALID_MATRIX_LIMITS_OR_DUPLICATE_CASES')
    execution = execution_identity()
    source_root('agentdojo')
    cases = [resolve_case(item) for item in selectors]
    manifest = {'schema': 1, 'protocol': 'keel-original-virtual-defense-v1', 'models': copy.deepcopy(models), 'localModel': copy.deepcopy(local_model),
        'seeds': seeds[:], 'selectors': copy.deepcopy(selectors), 'cases': cases, 'maxRequests': max_requests,
        'maxRequestsByModel': {model['id']: max_requests // len(models) + (index < max_requests % len(models)) for index, model in enumerate(models)},
        'maxProviderAttempts': max_requests * 5,
        'generation': {'temperature': 0.0, 'maxTokens': 2048}, 'implementation': execution,
        'sources': {'agentdojo': source_identity('agentdojo'), 'tau2': json.loads((HERE / 'upstream-lock.json').read_text())['tau2']},
        'policies': list(POLICIES), 'jobs': []}
    for model in models:
        for seed in seeds:
            for index, case in enumerate(cases):
                case_id = f'{index}:{seed}'
                binding = digest({'model': model, 'simulator': local_model, 'seed': seed, 'case': case, 'generation': manifest['generation'],
                                  'implementation': execution, 'sources': manifest['sources'], 'protocol': manifest['protocol']})
                for policy in POLICIES:
                    manifest['jobs'].append({'jobId': f'{model["id"]}:{case_id}:{policy}', 'caseId': case_id, 'model': model['id'],
                        'policy': policy, 'benchmark': case['benchmark'], 'kind': case['kind'], 'binding': binding})
    if len(manifest['jobs']) > 300: raise ValueError('MATRIX_JOB_LIMIT')
    manifest['bindingHash'] = digest(manifest)
    return manifest


def verify_manifest(manifest):
    try:
        rebuilt = prepare_manifest(models=manifest['models'], local_model=manifest['localModel'], seeds=manifest['seeds'],
                                   selectors=manifest['selectors'], max_requests=manifest['maxRequests'])
        if rebuilt != manifest: raise ValueError('MATRIX_MANIFEST_DRIFT')
    except (KeyError, TypeError, StopIteration):
        raise ValueError('MATRIX_MANIFEST_DRIFT') from None


def _account(clients):
    calls = sum(client.calls for client, _model in clients)
    records = [(record, model, f'{client.run_id}:{index + 1}') for client, model in clients for index, record in enumerate(client.records)]
    known = 0.0; complete = len(records) == calls
    identity_missing = calls == 0 or len(records) != calls; identity_mismatch = False
    provider_attempts = 0; unknown_attempt_calls = max(0, calls - len(records))
    for record, model, call_id in records:
        account = record.get('accounting') if isinstance(record.get('accounting'), dict) else {}
        cost = account.get('costUsd')
        valid = type(cost) in (int, float) and cost >= 0 and cost < float('inf')
        if valid: known += cost
        complete &= valid and account.get('costStatus') == 'known'
        if not account.get('model') or not account.get('provider'):
            identity_missing = True
        elif (account['model'], account['provider']) != (model['name'], model['provider']):
            identity_mismatch = True
        response = record.get('response') or {}
        call_ids = [value for value in (record.get('call_id'), response.get('call_id'), account.get('call_id')) if value is not None]
        if not call_ids:
            identity_missing = True
        elif any(value != call_id for value in call_ids):
            identity_mismatch = True
        if account.get('run_id') is not None and account['run_id'] != call_id.rsplit(':', 1)[0]:
            identity_mismatch = True
        attempts = account.get('attempts')
        if isinstance(attempts, list) and len(attempts) <= 5:
            provider_attempts += len(attempts)
        else:
            unknown_attempt_calls += 1
    return {'calls': calls, 'knownCostUsd': known, 'totalCostUsd': known if complete else None,
            'knownProviderAttempts': provider_attempts, 'totalProviderAttempts': provider_attempts if not unknown_attempt_calls else None,
            'providerAttemptUpperBound': provider_attempts + unknown_attempt_calls * 5,
            'generationIds': [f'{client.run_id}:{index + 1}' for client, _model in clients for index in range(client.calls)],
            'identityStatus': 'mismatch' if identity_mismatch else 'missing' if identity_missing else 'verified',
            'routeDrift': identity_missing or identity_mismatch}


class JournalClient(KeelClient):
    """Durable request-before-dispatch evidence, including incomplete calls."""
    def __init__(self, *args, journal, **kwargs):
        super().__init__(*args, **kwargs)
        self.journal = journal

    def persist(self, pending=None):
        temporary = self.journal.with_suffix('.pending')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump({'runId': self.run_id, 'calls': self.calls, 'records': self.records, 'exchanges': self.exchanges, 'pending': pending}, stream, allow_nan=False)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, self.journal)

    def step(self, messages, tools=None):
        if self.calls >= self.max_calls: raise ArtifactLimit('MATRIX_REQUEST_LIMIT')
        current = sum(path.stat().st_size for path in self.journal.parent.parent.rglob('*') if path.is_file())
        pending = {'callId': f'{self.run_id}:{self.calls + 1}', 'messages': messages, 'tools': tools}
        reserve = len(json.dumps({'records': self.records, 'exchanges': self.exchanges, 'pending': pending}).encode()) + 8_000_000
        if current + reserve > 16_000_000: raise ArtifactLimit('MATRIX_EVIDENCE_LIMIT')
        self.persist(pending)
        try:
            try:
                response = super().step(messages, tools)
            except RuntimeError:
                failed = self.exchanges[-1].get('response', {}) if self.exchanges else {}
                if failed.get('error') != 'INVALID_MODEL_RESPONSE': raise
                # Backend-invalid structured output is still an accounted model
                # generation. Let the bounded Task13 validator return feedback.
                return {'action': {}, 'invalidToolCalls': failed.get('invalidToolCalls', [])}
            if response.get('run_id') != self.run_id or response.get('call_id') != f'{self.run_id}:{self.calls}':
                raise RuntimeError('KEEL_RESPONSE_BINDING_DRIFT')
            return response
        finally:
            self.persist()


class ValidatedClient:
    """Task13 structural correction adapter; original legacy transport is unchanged."""
    def __init__(self, client): self.client = client
    def step(self, messages, tools=None):
        from agentdojo_agent import validate_action
        attempt_messages = copy.deepcopy(messages)
        for attempt in range(3):
            response = self.client.step(attempt_messages, tools)
            try:
                if response.get('invalidToolCalls'): raise RuntimeError('INVALID_MODEL_ACTION')
                validate_action(response.get('action'))
                return response
            except RuntimeError:
                if attempt == 2: raise
                attempt_messages.append({'role': 'user', 'content': 'INVALID_MODEL_ACTION: Return a valid text answer or schema-valid tool call. No tool was executed.'})


def _execute(manifest, job, endpoint, token, directory, remaining, *, local_endpoint=None, local_token=None):
    index, seed = map(int, job['caseId'].split(':'))
    case = manifest['cases'][index]
    model = next(model for model in manifest['models'] if model['id'] == job['model'])
    run_id = str(uuid.uuid4())
    started = time.monotonic()
    if case['benchmark'] == 'controlled':
        journal = directory / 'transport.json'
        try:
            result = _ts('controlled', {**case['selector'], 'host': case['host'], 'policy': job['policy'], 'endpoint': endpoint,
                'modelAlias': model['alias'], 'runId': run_id, 'seed': seed, 'maxRequests': remaining, 'journal': str(journal)}, token)
        except Exception:
            result = {'transport': json.loads(journal.read_text()) if journal.exists() else {'calls': 0, 'records': []},
                      'status': 'failed', 'attackSuccess': None, 'utility': None, 'blocked': None, 'interrupted': True}
        class Observed:
            pass
        client = Observed(); client.calls = result['transport']['calls']; client.records = result['transport']['records']; client.run_id = run_id
        accounting = _account([(client, model)])
        drift = accounting.pop('routeDrift')
        admission_stop = result.get('admissionStop') if result.get('admissionStop') in ADMISSION_CODES else None
        concluded = result['status'] == 'completed' or bool(result['blocked'])
        attack_score = True if result['attackSuccess'] is True else False if concluded and result['attackSuccess'] is False else None
        utility_score = float(result['utility']) if concluded and result['utility'] is not None else None
        if drift: attack_score = None; utility_score = None
        return {**accounting, 'runId': run_id, 'status': 'failed' if drift or result.get('interrupted') or admission_stop else 'blocked' if result['blocked'] == 'needs_approval' else 'completed' if concluded else 'failed',
            'attackSuccess': attack_score if job['kind'] == 'attack' else None,
            'utility': utility_score if job['kind'] == 'clean' else None,
            'latencyMs': (time.monotonic() - started) * 1000}, {**result, 'stop': bool(admission_stop) or drift or result.get('interrupted', False) or client.calls >= remaining}
    config_path = directory / 'host.json'
    config = {'tenantId': 'virtual-matrix', 'runId': run_id, 'tools': case['host']['tools'], 'capabilities': case['host']['capabilities'],
        'options': {'plan': case['host']['plan']}, 'benchmark': {'policy': job['policy'], 'taskHash': case['host']['taskHash']}}
    config_path.write_text(json.dumps(config)); os.chmod(config_path, 0o600)
    guard = KeelGuard(config_path, directory / 'state.json')
    agent = JournalClient(endpoint, token, model=model['alias'], seed=seed, max_calls=remaining, journal=directory / 'agent-transport.json')
    clients = [(agent, model)]
    result = {}; error = None; stopped = False
    try:
        if case['benchmark'] == 'agentdojo':
            from agentdojo_agent import run_agentdojo_case
            result = run_agentdojo_case(ValidatedClient(agent), **case['selector'], trusted_guard=guard, tool_error_limit=2)
            score = result['injection_success'] if job['kind'] == 'attack' else float(result['utility'])
        else:
            from tau2_security import tool_boundary, security_model_boundary
            from tau2.runner.build import build_text_orchestrator
            from tau2.runner.simulation import run_simulation
            same_local = all(model[key] == manifest['localModel'][key] for key in ('name', 'provider', 'version'))
            if not same_local and (not local_endpoint or not local_token or local_endpoint == endpoint):
                raise ValueError('SEPARATE_LOCAL_SIMULATOR_BACKEND_REQUIRED')
            local = JournalClient(local_endpoint or endpoint, local_token or token, model='local', seed=seed, max_calls=remaining, journal=directory / 'local-transport.json')
            clients.append((local, manifest['localModel']))
            tau_config, task = tau_task(case['selector'])
            orch = build_text_orchestrator(tau_config, task, seed=seed)
            with private_output() as diagnostics, security_model_boundary(agent, local, remaining), tool_boundary(orch, guard) as events:
                simulation = run_simulation(orch)
            result = {'simulation': simulation.model_dump(mode='json'), 'tool_events': events, 'diagnostics': diagnostics.evidence()}
            score = simulation.reward_info.reward
    except Exception as failure:
        error = type(failure).__name__
        result = {'failure_evidence': getattr(failure, 'security_evidence', {})}
        score = None
        stopped = isinstance(failure, (AdmissionStop, ArtifactLimit))
    accounting = _account(clients)
    drift = accounting.pop('routeDrift')
    if drift:
        score = None; error = 'MODEL_IDENTITY_MISSING' if accounting['identityStatus'] == 'missing' else 'OBSERVED_MODEL_ROUTE_DRIFT'; stopped = True
    blocked = any(decision['decision'] == 'needs_approval' for decision in guard.decisions)
    row = {**accounting, 'runId': run_id, 'status': 'failed' if error else 'blocked' if blocked else 'completed',
        'attackSuccess': score if job['kind'] == 'attack' else None, 'utility': score if job['kind'] == 'clean' else None,
        'latencyMs': (time.monotonic() - started) * 1000}
    return row, {'result': result, 'errorType': error, 'stop': stopped, 'host': config,
                 'transports': [{'records': client.records, 'exchanges': client.exchanges} for client, _model in clients]}


def run_manifest(manifest, *, endpoint, token, store, model_id=None, local_endpoint=None, local_token=None):
    verify_manifest(manifest)
    if model_id is None:
        if len(manifest['models']) != 1: raise ValueError('SELECT_INSTALLED_MODEL_REQUIRED')
        model_id = manifest['models'][0]['id']
    if model_id not in {model['id'] for model in manifest['models']}: raise ValueError('UNDECLARED_INSTALLED_MODEL')
    request_limit = manifest['maxRequestsByModel'][model_id]
    selected = next(model for model in manifest['models'] if model['id'] == model_id)
    if (any(job['model'] == model_id and job['benchmark'] == 'tau2' for job in manifest['jobs'])
        and any(selected[key] != manifest['localModel'][key] for key in ('name', 'provider', 'version'))
        and (not local_endpoint or not local_token or local_endpoint == endpoint)):
        raise ValueError('SEPARATE_LOCAL_SIMULATOR_BACKEND_REQUIRED')
    if any(store.directory.iterdir()): raise FileExistsError('MATRIX_OUTPUT_NOT_EMPTY')
    claim = store.directory / 'matrix.claim'
    fd = os.open(claim, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream: stream.write(manifest['bindingHash'])
    result = {'manifest': manifest, 'startedAt': datetime.now(timezone.utc).isoformat(), 'status': 'incomplete',
              'results': [{**job, 'status': 'not_attempted'} for job in manifest['jobs']]}
    rows = []; calls = 0; interrupted = None
    try:
        for index, job in enumerate(manifest['jobs']):
            if job['model'] != model_id: continue
            if calls >= request_limit: break
            # Each job gets its own output directory, so the per-directory journal cap in
            # JournalClient.step applies to one job rather than to the whole matrix run.
            job_store = ArtifactStore(store.directory / f'job-{index}', disk_usage=store.disk_usage)
            directory = job_store.directory / f'host-{index}'
            directory.mkdir(mode=0o700)
            try:
                value, private = _execute(manifest, job, endpoint, token, directory, request_limit - calls,
                                          local_endpoint=local_endpoint, local_token=local_token)
                row = {**job, **value, 'manifestHash': manifest['bindingHash']}
            except BaseException as error:
                # Incomplete physical dispatches survive interruption in journals.
                journals = [json.loads(path.read_text()) for path in directory.glob('*transport.json')]
                call_ids = []
                for journal in journals:
                    call_ids.extend(journal.get('generationIds', [f'{journal.get("runId", "unknown")}:{number + 1}' for number in range(journal['calls'])]))
                    if journal.get('pending'): call_ids.append(journal['pending']['callId'])
                attempt_arrays = [record['accounting']['attempts'] for journal in journals for record in journal.get('records', [])
                                  if isinstance(record.get('accounting'), dict) and isinstance(record['accounting'].get('attempts'), list)]
                known_attempts = sum(len(attempts) for attempts in attempt_arrays)
                unknown_attempt_calls = max(0, len(call_ids) - len(attempt_arrays))
                row = {**job, 'manifestHash': manifest['bindingHash'], 'runId': str(uuid.uuid4()), 'status': 'failed',
                       'attackSuccess': None, 'utility': None, 'calls': len(call_ids), 'generationIds': call_ids,
                       'knownCostUsd': sum(record.get('accounting', {}).get('costUsd', 0) for journal in journals for record in journal.get('records', []) if isinstance(record.get('accounting'), dict)),
                       'knownProviderAttempts': known_attempts, 'totalProviderAttempts': None if unknown_attempt_calls else known_attempts,
                       'providerAttemptUpperBound': known_attempts + unknown_attempt_calls * 5,
                       'totalCostUsd': None, 'latencyMs': None}
                private = {'errorType': type(error).__name__, 'stop': True, 'journals': journals}
                if not isinstance(error, Exception):
                    row['status'] = 'incomplete'; interrupted = error
            calls += row['calls']; rows.append(row)
            result['results'][index] = row
            job_store.write(f'case-{index}', {'row': row, 'evidence': private})
            if private.get('stop'): break
    finally:
        result['summary'] = _ts('aggregate', {'manifest': manifest, 'rows': rows})
        result['status'] = 'completed' if result['summary']['complete'] else 'incomplete'
        store.write('matrix-result', result)
    if interrupted: raise interrupted
    return result


def compose_results(results, store):
    if any(store.directory.iterdir()): raise FileExistsError('MATRIX_OUTPUT_NOT_EMPTY')
    if not results: raise ValueError('MATRIX_RESULTS_REQUIRED')
    manifest = results[0]['manifest']
    verify_manifest(manifest)
    if any(result['manifest'] != manifest for result in results): raise ValueError('MATRIX_COMPOSITION_DRIFT')
    rows = [row for result in results for row in result['results'] if row['status'] != 'not_attempted']
    summary = _ts('aggregate', {'manifest': manifest, 'rows': rows})
    if sum(row['calls'] for row in rows) > manifest['maxRequests']: raise ValueError('COMPOSED_REQUEST_LIMIT')
    if any(sum(row['calls'] for row in rows if row['model'] == model_id) > limit for model_id, limit in manifest['maxRequestsByModel'].items()):
        raise ValueError('COMPOSED_MODEL_REQUEST_LIMIT')
    output = {'manifest': manifest, 'results': rows, 'summary': summary, 'status': 'completed' if summary['complete'] else 'incomplete'}
    store.write('matrix-composed', output)
    return output


# Full AgentDojo benchmark (phase 6). Same case resolution, client, guard bridge and original
# scorers as above, but thousands of jobs: episodes run concurrently in spawned worker processes
# (upstream stdout capture is process-global), each job keeps compact gzip evidence, rows are
# appended to rows.jsonl, and a later batch resumes where the previous one stopped.
FULL_PROTOCOL = 'keel-agentdojo-full-v1'
FULL_POLICIES = POLICIES + ('provenance', 'all-prov')


def _full_body(manifest):
    return {key: value for key, value in manifest.items() if key != 'bindingHash'}


def prepare_full_manifest(*, model, selectors, policies, policy_cases, per_job_requests, sample=None):
    _model(model)
    if (not isinstance(selectors, list) or not 1 <= len(selectors) <= 2000 or not policies or len(set(policies)) != len(policies)
            or not set(policies) <= set(FULL_POLICIES) or set(policy_cases) != set(policies)
            or type(per_job_requests) is not int or not 1 <= per_job_requests <= 64
            or any(s['benchmark'] != 'agentdojo' for s in selectors)
            or len({digest(item) for item in selectors}) != len(selectors)):
        raise ValueError('INVALID_FULL_MATRIX')
    execution = execution_identity()
    cases = [resolve_case(item) for item in selectors]
    jobs = []
    for index, case in enumerate(cases):
        selector = case['selector']
        for policy in policies:
            chosen = policy_cases[policy]
            if chosen is None or index in set(chosen):
                jobs.append({'jobId': f'{model["id"]}:{index}:0:{policy}', 'caseIndex': index, 'policy': policy, 'kind': case['kind'],
                             'suite': selector['suite_name'], 'userTask': selector['user_task_id'], 'injectionTask': selector.get('injection_task_id')})
    if len(jobs) > 12000: raise ValueError('MATRIX_JOB_LIMIT')
    manifest = {'schema': 1, 'protocol': FULL_PROTOCOL, 'model': copy.deepcopy(model), 'seed': 0,
                'generation': {'temperature': 0.0, 'maxTokens': 2048}, 'implementation': execution,
                'sources': {'agentdojo': source_identity('agentdojo')}, 'policies': list(policies),
                'policyCases': copy.deepcopy(policy_cases), 'sample': copy.deepcopy(sample), 'perJobRequests': per_job_requests,
                'cases': cases, 'jobs': jobs}
    manifest['bindingHash'] = digest(manifest)
    return manifest


def verify_full_manifest(manifest):
    try:
        if manifest['protocol'] != FULL_PROTOCOL or manifest['bindingHash'] != digest(_full_body(manifest)):
            raise ValueError('MATRIX_MANIFEST_DRIFT')
        if manifest['implementation']['implementation'] != execution_identity()['implementation']:
            raise ValueError('MATRIX_IMPLEMENTATION_DRIFT')
    except (KeyError, TypeError):
        raise ValueError('MATRIX_MANIFEST_DRIFT') from None


def full_meta(manifest):
    return {'model': manifest['model'], 'seed': manifest['seed'], 'perJobRequests': manifest['perJobRequests'], 'manifestHash': manifest['bindingHash']}


class RecordingGuard(KeelGuard):
    """Same bridge; also keeps (op, tool, decision) for every event. Never arguments."""
    def __init__(self, *args, **kwargs):
        self.events = []
        super().__init__(*args, **kwargs)

    def _invoke(self, event):
        try:
            super()._invoke(event)
        finally:
            if event['op'] != 'init':
                self.events.append({'op': event['op'], 'tool': event.get('tool'), 'decision': (self.last_decision or {}).get('decision')})


def execute_full_job(meta, case, job, endpoint, token, directory):
    from agentdojo_agent import run_agentdojo_case
    directory = Path(directory); directory.mkdir(mode=0o700)
    run_id = str(uuid.uuid4())
    config = {'tenantId': 'virtual-matrix', 'runId': run_id, 'tools': case['host']['tools'], 'capabilities': case['host']['capabilities'],
              'options': {'plan': case['host']['plan']}, 'benchmark': {'policy': job['policy'], 'taskHash': case['host']['taskHash'],
              # The trusted user request (the same text the task hash binds); provenance policies read it.
              'trustedText': case['input']['initialTask']}}
    config_path = directory / 'host.json'
    config_path.write_text(json.dumps(config)); os.chmod(config_path, 0o600)
    started = time.monotonic()
    guard = RecordingGuard(config_path, directory / 'state.json')
    guard.last_decision = None
    # JournalClient caps evidence under journal.parent.parent: keep that the job's own directory.
    (directory / 'host').mkdir(mode=0o700)
    agent = JournalClient(endpoint, token, model='local', seed=meta['seed'], max_calls=meta['perJobRequests'], journal=directory / 'host' / 'agent-transport.json')
    error = None; result = {}
    try:
        result = run_agentdojo_case(ValidatedClient(agent), **case['selector'], trusted_guard=guard, tool_error_limit=2, score_exhausted=True)
    except Exception as failure:
        code = str(failure)
        error = type(failure).__name__ + (':' + code if code.isupper() and len(code) <= 64 else '')
        result = getattr(failure, 'security_evidence', {})
    accounting = _account([(agent, meta['model'])])
    if accounting.pop('routeDrift') and not error:
        error = 'MODEL_IDENTITY_' + accounting['identityStatus'].upper()
    usage = [(exchange.get('response') or {}).get('usage') or {} for exchange in agent.exchanges]
    denials = [event for event in guard.events if event['decision'] != 'allow']
    scored = error is None
    row = {'jobId': job['jobId'], 'caseIndex': job['caseIndex'], 'policy': job['policy'], 'kind': job['kind'], 'suite': job['suite'],
           'userTask': job['userTask'], 'injectionTask': job['injectionTask'], 'runId': run_id, 'manifestHash': meta['manifestHash'],
           'status': 'completed' if scored else 'failed', 'errorType': error,
           'utility': bool(result['utility']) if scored else None,
           'attackSuccess': (bool(result['injection_success']) if scored else None) if job['kind'] == 'attack' else None,
           'exhausted': bool(result.get('exhausted')) if scored else None,
           'blocked': any(event['decision'] == 'needs_approval' for event in denials), 'denials': denials,
           'toolCalls': len(result.get('tool_events', [])), 'calls': accounting['calls'],
           'inputTokens': sum(u.get('input', 0) or 0 for u in usage), 'outputTokens': sum(u.get('output', 0) or 0 for u in usage),
           'knownCostUsd': accounting['knownCostUsd'], 'identityStatus': accounting['identityStatus'],
           # Backend error codes of failed model requests (e.g. INPUT_LIMIT, MODEL_TIMEOUT, REQUEST_LIMIT).
           'transportErrors': [(exchange.get('response') or {}).get('error') for exchange in agent.exchanges if (exchange.get('response') or {}).get('error')],
           'latencyMs': (time.monotonic() - started) * 1000}
    evidence = {'row': row, 'messages': result.get('messages'), 'toolEvents': result.get('tool_events'), 'guard': guard.events,
                'records': agent.records, 'usage': usage}
    fd = os.open(directory / 'evidence.json.gz', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(gzip.compress(json.dumps(evidence, ensure_ascii=False, default=str).encode(), mtime=0))
    for name in ('agent-transport.json', 'agent-transport.pending'):
        (directory / 'host' / name).unlink(missing_ok=True)
    return row


def _spawn_executor(workers):
    import multiprocessing
    from concurrent.futures import ProcessPoolExecutor
    return ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context('spawn'))


def run_full(manifest, *, endpoint, token, output, workers, deadline_seconds, executor=None, execute=execute_full_job, limit=None):
    """Run every job without a row yet, `workers` at a time; stop submitting at the deadline."""
    from concurrent.futures import FIRST_COMPLETED, wait
    verify_full_manifest(manifest)
    if not 1 <= workers <= 32: raise ValueError('INVALID_WORKERS')
    output = Path(output); output.mkdir(mode=0o700, exist_ok=True)
    rows_path = output / 'rows.jsonl'
    done = {json.loads(line)['jobId'] for line in rows_path.read_text().splitlines()} if rows_path.exists() else set()
    pending = [job for job in manifest['jobs'] if job['jobId'] not in done][:limit]
    batch = 1 + sum(1 for _ in output.glob('run-*.json'))
    meta = full_meta(manifest)
    started = datetime.now(timezone.utc).isoformat(); clock = time.monotonic(); deadline = clock + deadline_seconds
    executor = executor or _spawn_executor(workers)
    submitted = 0; completed = 0; futures = {}
    (output / 'jobs').mkdir(mode=0o700, exist_ok=True)
    with executor, rows_path.open('a') as rows:
        while pending or futures:
            while pending and len(futures) < workers and time.monotonic() < deadline:
                job = pending.pop(0)
                directory = output / 'jobs' / f'{job["caseIndex"]}-{job["policy"]}-{uuid.uuid4().hex[:8]}'
                futures[executor.submit(execute, meta, manifest['cases'][job['caseIndex']], job, endpoint, token, str(directory))] = job
                submitted += 1
            if not futures: break
            finished, _ = wait(list(futures), return_when=FIRST_COMPLETED)
            for future in finished:
                job = futures.pop(future)
                try:
                    row = future.result()
                except Exception as failure:
                    row = {'jobId': job['jobId'], 'caseIndex': job['caseIndex'], 'policy': job['policy'], 'kind': job['kind'], 'suite': job['suite'],
                           'userTask': job['userTask'], 'injectionTask': job['injectionTask'], 'manifestHash': manifest['bindingHash'],
                           'status': 'failed', 'errorType': 'WORKER_' + type(failure).__name__, 'utility': None, 'attackSuccess': None, 'calls': None}
                rows.write(json.dumps(row) + '\n'); rows.flush(); os.fsync(rows.fileno())
                completed += 1
    summary = {'batch': batch, 'manifestHash': manifest['bindingHash'], 'startedAt': started, 'finishedAt': datetime.now(timezone.utc).isoformat(),
               'seconds': round(time.monotonic() - clock, 1), 'workers': workers, 'submitted': submitted, 'completedThisBatch': completed,
               'completed': len(done) + completed, 'planned': len(manifest['jobs'])}
    (output / f'run-{batch}.json').write_text(json.dumps(summary, indent=1))
    return summary


def main():
    # Dedicated CLI process: original tau logs include task/model payloads.
    from loguru import logger
    import logging
    logger.remove(); logging.disable(logging.CRITICAL)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('prepare', 'run', 'compose', 'prepare-full', 'run-full'))
    parser.add_argument('--input', type=Path, required=True, help='Private JSON preparation spec or gzip manifest artifact')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--endpoint', default='http://127.0.0.1:18080')
    parser.add_argument('--model-id')
    parser.add_argument('--local-endpoint')
    # run-full only: concurrent episodes and the wall-clock point after which no job is started.
    parser.add_argument('--workers', type=int, default=1)
    parser.add_argument('--deadline-seconds', type=int, default=3000)
    args = parser.parse_args()
    if args.command == 'prepare-full':
        if args.output.exists(): raise FileExistsError('MATRIX_OUTPUT_EXISTS')
        spec = json.loads(args.input.read_text())
        manifest = prepare_full_manifest(model=spec['model'], selectors=spec['selectors'], policies=spec['policies'],
                                         policy_cases=spec['policy_cases'], per_job_requests=spec['per_job_requests'], sample=spec.get('sample'))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(args.output, 'xt') as stream: json.dump(manifest, stream)
        print(json.dumps({'bindingHash': manifest['bindingHash'], 'jobs': len(manifest['jobs']), 'cases': len(manifest['cases'])}))
        return
    if args.command == 'run-full':
        with gzip.open(args.input, 'rt') as stream: manifest = json.load(stream)
        token = os.environ.get('KEEL_SECURITY_TOKEN')
        if not token: raise ValueError('KEEL_SECURITY_TOKEN_REQUIRED')
        print(json.dumps(run_full(manifest, endpoint=args.endpoint, token=token, output=args.output, workers=args.workers,
                                  deadline_seconds=args.deadline_seconds)), flush=True)
        return
    if args.output.exists(): raise FileExistsError('MATRIX_OUTPUT_EXISTS')
    if args.input.stat().st_size > 8_000_000: raise ValueError('MATRIX_INPUT_LIMIT')
    store = ArtifactStore(args.output)
    if args.command == 'prepare':
        store.write('manifest', prepare_manifest(**json.loads(args.input.read_text())))
    elif args.command == 'run':
        with gzip.open(args.input, 'rb') as stream: raw = stream.read(8_000_001)
        if len(raw) > 8_000_000: raise ValueError('MATRIX_INPUT_LIMIT')
        token = os.environ.get('KEEL_SECURITY_TOKEN')
        if not token: raise ValueError('KEEL_SECURITY_TOKEN_REQUIRED')
        run_manifest(json.loads(raw), endpoint=args.endpoint, token=token, store=store, model_id=args.model_id,
                     local_endpoint=args.local_endpoint, local_token=os.environ.get('KEEL_SECURITY_LOCAL_TOKEN'))
    else:
        paths = json.loads(args.input.read_text())
        if not isinstance(paths, list) or not 1 <= len(paths) <= 3: raise ValueError('FINITE_COMPOSITION_REQUIRED')
        results = []
        for path in paths:
            with gzip.open(path, 'rb') as stream: raw = stream.read(8_000_001)
            if len(raw) > 8_000_000: raise ValueError('MATRIX_INPUT_LIMIT')
            results.append(json.loads(raw))
        compose_results(results, store)


if __name__ == '__main__':
    main()

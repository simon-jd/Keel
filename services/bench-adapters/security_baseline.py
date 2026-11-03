"""Thin offline manifest / admitted Keel execution facade; no provisioning or policy.

Run only after controller resource admission. Raw manifests/results are private,
exclusive artifacts, including failed and not-attempted rows. This module never
starts a backend or chooses a model/provider on the controller's behalf.
"""
import argparse
import copy
from datetime import datetime, timezone
import gzip
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import time

from artifacts import ArtifactStore
from keel_client import AdmissionStop, KeelClient
from security_sources import ROOT, source_identity, source_root

HERE = Path(__file__).resolve().parent


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _runtime_binding():
    names = ('agentdojo_agent.py', 'injecagent_runner.py', 'security_baseline.py', 'security_sources.py',
             'security-upstream.lock.json', 'security-requirements.lock', 'keel_client.py', 'artifacts.py')
    return {'git': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
            'python': platform.python_version(),
            'packages': sorted([dist.metadata['Name'], dist.version] for dist in importlib.metadata.distributions()),
            'adapter_sha256': {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest() for name in names}}


def prepare_manifest(*, protocol, model, seed, max_requests, selectors, setting='base', prompt_type='InjecAgent', benchmark_version='v1'):
    if protocol not in ('agentdojo', 'injecagent') or not isinstance(model, str) or not model or len(model) > 128:
        raise ValueError('INVALID_SECURITY_PROTOCOL_OR_MODEL')
    if type(seed) is not int or not 0 <= seed < 2**32 or type(max_requests) is not int or not 1 <= max_requests <= 1000:
        raise ValueError('INVALID_SECURITY_LIMITS')
    if not isinstance(selectors, list) or not 0 < len(selectors) <= 100 or len(json.dumps(selectors).encode()) > 1_000_000:
        raise ValueError('INVALID_SECURITY_CASES')
    if len({digest(selector) for selector in selectors}) != len(selectors):
        raise ValueError('DUPLICATE_SECURITY_CASE')
    source_root(protocol)
    cases = []
    if protocol == 'injecagent':
        from injecagent_runner import load_injecagent_cases
        if prompt_type not in ('InjecAgent', 'hwchase17_react'):
            raise ValueError('INVALID_INJECAGENT_PROMPT')
        dataset = load_injecagent_cases(setting)
        for selector in selectors:
            if set(selector) != {'kind', 'index'} or selector['kind'] not in dataset or type(selector['index']) is not int:
                raise ValueError('INVALID_INJECAGENT_SELECTOR')
            index = selector['index']
            if not 0 <= index < len(dataset[selector['kind']]):
                raise ValueError('INVALID_INJECAGENT_SELECTOR')
            item = dataset[selector['kind']][index]
            cases.append({'selector': copy.deepcopy(selector), 'input': item, 'input_sha256': digest(item)})
    else:
        from agentdojo_agent import get_suite
        for selector in selectors:
            if not {'suite_name', 'user_task_id'} <= set(selector) or set(selector) - {'suite_name', 'user_task_id', 'injection_task_id', 'injections'}:
                raise ValueError('INVALID_AGENTDOJO_SELECTOR')
            suite = get_suite(benchmark_version, selector['suite_name'])
            user = suite.get_user_task_by_id(selector['user_task_id'])
            attack_id = selector.get('injection_task_id')
            attack = suite.get_injection_task_by_id(attack_id) if attack_id else None
            injections = selector.get('injections', {})
            if not isinstance(injections, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in injections.items()):
                raise ValueError('INVALID_AGENTDOJO_INJECTIONS')
            suite.load_and_inject_default_environment(injections)
            item = {'prompt': user.PROMPT, 'attack_goal': attack.GOAL if attack else None, 'injections': injections}
            cases.append({'selector': copy.deepcopy(selector), 'input': item, 'input_sha256': digest(item)})
    manifest = {'schema_version': 1, 'protocol': protocol, 'model': model, 'seed': seed, 'max_requests': max_requests,
                'setting': setting, 'prompt_type': prompt_type, 'benchmark_version': benchmark_version,
                'source': source_identity(protocol), 'runtime': _runtime_binding(), 'cases': cases, 'defense': None,
                'generation': {'temperature': 0.0, 'max_tokens': 2048}}
    manifest['binding_sha256'] = digest(manifest)
    return manifest


def verify_manifest(manifest):
    try:
        rebuilt = prepare_manifest(protocol=manifest['protocol'], model=manifest['model'], seed=manifest['seed'],
            max_requests=manifest['max_requests'], selectors=[case['selector'] for case in manifest['cases']],
            setting=manifest['setting'], prompt_type=manifest['prompt_type'], benchmark_version=manifest['benchmark_version'])
        if rebuilt != manifest:
            raise RuntimeError('MANIFEST_BINDING_MISMATCH')
    except (KeyError, TypeError, ValueError):
        raise RuntimeError('MANIFEST_BINDING_MISMATCH') from None


def _transport(client):
    return {'model': client.model, 'seed': client.seed, 'temperature': getattr(client, 'temperature', None),
            'max_tokens': getattr(client, 'max_tokens', None), 'run_id': getattr(client, 'run_id', None),
            'calls': getattr(client, 'calls', None), 'max_calls': client.max_calls,
            'records': copy.deepcopy(getattr(client, 'records', [])),
            'exchanges': copy.deepcopy(getattr(client, 'exchanges', []))}


def run_manifest(manifest, client, store):
    verify_manifest(manifest)
    if (client.model, client.seed, client.max_calls) != (manifest['model'], manifest['seed'], manifest['max_requests']):
        raise ValueError('SECURITY_CLIENT_BINDING_MISMATCH')
    if (getattr(client, 'temperature', 0.0), getattr(client, 'max_tokens', 2048)) != (0.0, 2048):
        raise ValueError('SECURITY_GENERATION_BINDING_MISMATCH')
    if getattr(client, 'calls', 0) != 0:
        raise ValueError('SECURITY_FRESH_CLIENT_REQUIRED')
    # Claim before any model work, never overwrite/retry into an existing evidence directory.
    if any(store.directory.iterdir()):
        raise FileExistsError('SECURITY_OUTPUT_NOT_EMPTY')
    claim = store.directory / 'security-run.claim'
    fd = os.open(claim, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(manifest['binding_sha256'])
    started = time.monotonic()
    result = {'manifest': manifest, 'started_at': datetime.now(timezone.utc).isoformat(),
              'planned': len(manifest['cases']),
              'results': [{'selector': case['selector'], 'status': 'not_attempted'} for case in manifest['cases']],
              'status': 'failed'}
    interrupted = None
    try:
        if manifest['protocol'] == 'injecagent':
            from injecagent_runner import run_injecagent
            cases = {kind: [case['input'] for case in manifest['cases'] if case['selector']['kind'] == kind] for kind in ('dh', 'ds')}
            indices = {kind: [index for index, case in enumerate(manifest['cases']) if case['selector']['kind'] == kind]
                       for kind in ('dh', 'ds')}
            def observe(kind, index, item):
                row = result['results'][indices[kind][index]]
                row['status'], row['row'] = item['adapter_status'], item
            batch = run_injecagent(client, cases, prompt_type=manifest['prompt_type'], case_observer=observe)
            result['batch'] = batch
            result['status'] = batch['status']
        else:
            from agentdojo_agent import run_agentdojo_case
            stopped = False
            for case, row in zip(manifest['cases'], result['results']):
                if stopped:
                    continue
                row['status'] = 'running'
                try:
                    row['result'] = run_agentdojo_case(client, benchmark_version=manifest['benchmark_version'], **case['selector'])
                    row['status'] = 'completed'
                except Exception as error:
                    row['status'] = 'failed'
                    row['error_type'] = type(error).__name__
                    row['failure_evidence'] = getattr(error, 'security_evidence', {})
                    stopped = isinstance(error, AdmissionStop) or getattr(client, 'calls', 0) >= client.max_calls
            result['status'] = 'completed' if all(row['status'] == 'completed' for row in result['results']) else 'failed'
    except BaseException as error:
        result['error_type'] = type(error).__name__
        for row in result['results']:
            if row['status'] == 'running':
                row['status'] = 'incomplete'
                row['failure_evidence'] = getattr(error, 'security_evidence', {})
        interrupted = error
    finally:
        if manifest['protocol'] == 'agentdojo':
            attacks = [row for row in result['results'] if row['selector'].get('injection_task_id')]
            clean = [row for row in result['results'] if not row['selector'].get('injection_task_id')]
            attack_success = sum(row.get('result', {}).get('injection_success') is True for row in attacks)
            clean_success = sum(row.get('result', {}).get('utility') is True for row in clean)
            result['metrics'] = {'attack_planned': len(attacks), 'attack_success': attack_success,
                'asr_all': attack_success / len(attacks) if attacks else None,
                'clean_planned': len(clean), 'clean_utility_success': clean_success,
                'clean_utility_all': clean_success / len(clean) if clean else None,
                'completed': sum(row['status'] == 'completed' for row in result['results'])}
        result['elapsed_seconds'] = time.monotonic() - started
        result['transport'] = _transport(client)
        store.write('security-result', result)
    if interrupted:
        raise interrupted
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prepare = commands.add_parser('prepare')
    prepare.add_argument('--protocol', choices=['agentdojo', 'injecagent'], required=True)
    prepare.add_argument('--model', required=True)
    prepare.add_argument('--seed', type=int, required=True)
    prepare.add_argument('--max-requests', type=int, required=True)
    prepare.add_argument('--selectors', type=Path, required=True, help='Private JSON list of fixed upstream selectors')
    prepare.add_argument('--setting', choices=['base', 'enhanced'], default='base')
    prepare.add_argument('--prompt-type', choices=['InjecAgent', 'hwchase17_react'], default='InjecAgent')
    prepare.add_argument('--benchmark-version', default='v1')
    prepare.add_argument('--output', type=Path, required=True, help='New private artifact directory')
    run = commands.add_parser('run')
    run.add_argument('--manifest', type=Path, required=True)
    run.add_argument('--endpoint', required=True)
    run.add_argument('--output', type=Path, required=True, help='New exclusive private result directory')
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError('SECURITY_OUTPUT_EXISTS')
    store = ArtifactStore(args.output)
    if args.command == 'prepare':
        if args.selectors.stat().st_size > 1_000_000:
            raise ValueError('SECURITY_SELECTOR_LIMIT')
        manifest = prepare_manifest(protocol=args.protocol, model=args.model, seed=args.seed, max_requests=args.max_requests,
            selectors=json.loads(args.selectors.read_text()), setting=args.setting, prompt_type=args.prompt_type,
            benchmark_version=args.benchmark_version)
        store.write('manifest', manifest)
    else:
        if args.manifest.stat().st_size > 8_000_000:
            raise ValueError('SECURITY_MANIFEST_LIMIT')
        with gzip.open(args.manifest, 'rb') as stream:
            raw = stream.read(8_000_001)
        if len(raw) > 8_000_000:
            raise ValueError('SECURITY_MANIFEST_LIMIT')
        manifest = json.loads(raw)
        verify_manifest(manifest)
        token = os.environ.get('KEEL_SECURITY_TOKEN')
        if not token:
            raise ValueError('KEEL_SECURITY_TOKEN_REQUIRED')
        client = KeelClient(args.endpoint, token, model=manifest['model'], seed=manifest['seed'], max_calls=manifest['max_requests'])
        run_manifest(manifest, client, store)


if __name__ == '__main__':
    main()

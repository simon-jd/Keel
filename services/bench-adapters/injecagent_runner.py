"""Pinned InjecAgent prompted protocol, parser, simulator and scorer via Keel.

Only three exact import-time AST nodes are removed: the legacy MODELS import,
OpenAI import and import-time OpenAI constructor. Original function bodies are
verified unchanged. Legacy main/providers never run. Process-global imports/cwd
are serialized; original files/cache are read-only and all derived files private.
"""
import ast
import copy
from contextlib import contextmanager
import hashlib
import importlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import ModuleType, SimpleNamespace

from keel_client import AdmissionStop
from security_sources import private_output, source_identity, source_root

_REMOVED = {
    'src.utils': [
        'from openai import OpenAI',
        'client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"), organization=os.environ.get("OPENAI_ORGANIZATION"))',
    ],
    'src.evaluate_prompted_agent': ['from src.models import MODELS'],
}


def _dump(node):
    return ast.dump(node, include_attributes=False)


def _load_adapted(name, path, injected):
    source = path.read_bytes()
    tree = ast.parse(source, filename=str(path))
    protected = {node.name: _dump(node) for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    expected = [_dump(ast.parse(text).body[0]) for text in _REMOVED[name]]
    found = []
    kept = []
    for node in tree.body:
        value = _dump(node)
        if value in expected:
            found.append(value)
        else:
            kept.append(node)
    if sorted(found) != sorted(expected):
        raise RuntimeError('UNEXPECTED_UPSTREAM_TRANSPORT_AST')
    tree.body = kept
    if protected != {node.name: _dump(node) for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}:
        raise RuntimeError('UPSTREAM_FUNCTION_BODY_CHANGED')
    transformed = ast.unparse(tree)
    module = ModuleType(name)
    module.__file__ = str(path)
    module.__package__ = 'src'
    module.__dict__.update(injected)
    sys.modules[name] = module
    exec(compile(tree, str(path), 'exec'), module.__dict__)
    evidence = {'module': name, 'source_sha256': hashlib.sha256(source).hexdigest(),
                'transformed_sha256': hashlib.sha256(transformed.encode()).hexdigest(),
                'removed_nodes': _REMOVED[name],
                'protected_functions': {key: hashlib.sha256(value.encode()).hexdigest() for key, value in protected.items()}}
    return module, evidence


class KeelPromptedModel:
    def __init__(self, client):
        self.client = client

    def prepare_input(self, system_prompt, user_prompt):
        return [{'role': 'system', 'content': system_prompt}, {'role': 'user', 'content': user_prompt}]

    def call_model(self, messages):
        response = self.client.step(messages, [])
        if response.get('invalidToolCalls') or response['action'].get('toolCalls'):
            raise RuntimeError('INJECAGENT_EXPECTED_PROMPTED_TEXT')
        content = response['action'].get('content')
        if not isinstance(content, str) or len(content.encode()) > 256_000:
            raise RuntimeError('INJECAGENT_OUTPUT_LIMIT')
        return content


class KeelSimulatorBridge:
    def __init__(self, client, events):
        self.transport = KeelPromptedModel(client)
        self.events = events
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def create(self, *, model, messages):
        if model != 'gpt-4-0613':
            raise RuntimeError('UNEXPECTED_SIMULATOR_PROTOCOL')
        self.events.append({'mode': 'keel-generation', 'legacy_upstream_model_argument': model,
                            'configured_keel_model': getattr(self.transport.client, 'model', None)})
        content = self.transport.call_model(messages)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


@contextmanager
def _original_modules(client, simulator_events):
    root = source_root('injecagent')
    if any(name == 'src' or name.startswith('src.') for name in sys.modules):
        raise RuntimeError('SECURITY_UPSTREAM_IMPORT_COLLISION')
    old_path = sys.path[:]
    try:
        sys.path.insert(0, str(root))
        # Real namespace package and actual upstream modules; never import legacy models.
        importlib.import_module('src')
        utils, utils_evidence = _load_adapted('src.utils', root / 'src/utils.py',
                                             {'client': KeelSimulatorBridge(client, simulator_events)})
        predict, predict_evidence = _load_adapted('src.evaluate_prompted_agent', root / 'src/evaluate_prompted_agent.py', {})
        parser = importlib.import_module('src.output_parsing')
        yield utils, predict, parser, [utils_evidence, predict_evidence]
    finally:
        for name in list(sys.modules):
            if name == 'src' or name.startswith('src.'):
                del sys.modules[name]
        sys.path[:] = old_path


def load_injecagent_cases(setting='base'):
    if setting not in ('base', 'enhanced'):
        raise ValueError('INVALID_INJECAGENT_SETTING')
    root = source_root('injecagent')
    return {kind: json.loads((root / f'data/test_cases_{kind}_{setting}.json').read_text()) for kind in ('dh', 'ds')}


def _counts(rows):
    result = {}
    for kind, items in rows.items():
        counts = {'total': len(items), 'succ': 0, 'unsucc': 0, 'invalid': 0,
                  's2_succ': 0, 's2_unsucc': 0, 's2_invalid': 0, 's2_not_attempted': 0}
        for item in items:
            counts[item['eval']] += 1
            if kind == 'ds' and item['eval'] == 'succ':
                value = item.get('eval Step 2')
                counts['s2_' + value if value else 's2_not_attempted'] += 1
        result[kind] = counts
    return result


def run_injecagent(client, cases, *, prompt_type='InjecAgent', case_observer=None):
    """Run a bounded batch with original prompted metrics, keeping every planned row.

    Parsed attack-tool intent is not an actual sink action or benign utility.
    The original simulator's read-through cache is copied to a private temporary
    cwd. Hits are replay, misses are newly accounted Keel calls; source immutable.
    Returned raw rows/prompts belong only in private immutable evidence storage.
    """
    if set(cases) != {'dh', 'ds'} or not 0 < sum(len(v) for v in cases.values()) <= 100:
        raise ValueError('INJECAGENT_BATCH_LIMIT')
    if len(json.dumps(cases).encode()) > 4_000_000:
        raise ValueError('INJECAGENT_INPUT_LIMIT')
    rows = copy.deepcopy(cases)
    simulator_events = []
    failed = False
    stop = False
    with private_output() as diagnostics, tempfile.TemporaryDirectory(prefix='keel-injecagent-') as temporary:
        root = source_root('injecagent')
        directory = Path(temporary)
        (directory / 'data').mkdir(mode=0o700)
        for relative in ('data/tools.json', 'data/attacker_simulated_responses.json'):
            shutil.copyfile(root / relative, directory / relative)
            (directory / relative).chmod(0o600)
        previous_cwd = Path.cwd()
        try:
            os.chdir(directory)
            with _original_modules(client, simulator_events) as (utils, predict, parser, import_evidence):
                if prompt_type not in predict.PROMPT_DICT:
                    raise ValueError('INVALID_INJECAGENT_PROMPT')
                system_prompt, user_prompt = predict.PROMPT_DICT[prompt_type]
                model = KeelPromptedModel(client)
                tools = utils.get_tool_dict()
                for kind in ('dh', 'ds'):
                    for index, item in enumerate(rows[kind]):
                        # Strip previous outputs/evaluations: no cached answers masquerade as inference.
                        for key in ('eval', 'output', 'eval Step 2', 'output Step 2', 'invalid_reason', 'invalid_reason  Step 2',
                                    'Attacker Tool Parameters', 'Attacker Tool Thought', 'Attacker Tool Response'):
                            item.pop(key, None)
                        item['eval'] = 'invalid'
                        item['adapter_status'] = 'not_attempted'
                        if stop:
                            item['invalid_reason'] = 'adapter_admission_stopped'
                            if case_observer:
                                case_observer(kind, index, copy.deepcopy(item))
                            continue
                        item['adapter_status'] = 'running'
                        if case_observer:
                            case_observer(kind, index, copy.deepcopy(item))
                        try:
                            output = predict.predict_one_case(system_prompt, user_prompt, {}, item, model, tools)
                            item['output'] = output
                            parsed = parser.evaluate_output_prompted(output, item['Attacker Tools'][0], item['Attacker Tools'],
                                                                     item['User Tool'], item['Attacker Instruction'])
                            item.update({key: value for key, value in parsed.items() if key in ('eval', 'invalid_reason')})
                            if kind == 'ds' and item['eval'] == 'succ':
                                item['Attacker Tool Parameters'] = parsed['Attacker Tool Parameters']
                                item['Attacker Tool Thought'] = parsed['Attacker Tool Thought']
                                key = f"({item['Attacker Tools'][0]},{item['Attacker Tool Parameters']})"
                                cache = json.loads((directory / 'data/attacker_simulated_responses.json').read_text())
                                if key in cache:
                                    simulator_events.append({'mode': 'cached-response-replay', 'configured_keel_model': None})
                                item['Attacker Tool Response'] = utils.get_simulated_attacker_tool_response(
                                    item['Attacker Tools'][0], item['Attacker Tool Parameters'], tools)
                                output = predict.predict_one_case(system_prompt, user_prompt, {}, item, model, tools, step_2=True)
                                item['output Step 2'] = output
                                parsed = parser.evaluate_output_prompted(output, item['Attacker Tools'][1], item['Attacker Tools'],
                                                                         item['User Tool'], item['Attacker Instruction'])
                                item['eval Step 2'] = parsed['eval']
                                if 'invalid_reason' in parsed:
                                    item['invalid_reason  Step 2'] = parsed['invalid_reason']
                            item['adapter_status'] = 'completed'
                        except Exception as error:
                            failed = True
                            stop = isinstance(error, AdmissionStop)
                            item['adapter_status'] = 'error'
                            item['adapter_error_type'] = type(error).__name__
                            if kind == 'ds' and item['eval'] == 'succ':
                                item['eval Step 2'] = 'invalid'
                                item['invalid_reason  Step 2'] = 'adapter_error'
                            else:
                                item['eval'] = 'invalid'
                                item['invalid_reason'] = 'adapter_error'
                        finally:
                            if case_observer:
                                case_observer(kind, index, copy.deepcopy(item))
                files = {}
                for kind in ('dh', 'ds'):
                    path = directory / f'{kind}.jsonl'
                    with path.open('x') as stream:
                        path.chmod(0o600)
                        for item in rows[kind]:
                            stream.write(json.dumps(item) + '\n')
                    files[kind] = str(path)
                scores = utils.get_score(files)
        finally:
            os.chdir(previous_cwd)
    return {'protocol': 'original-injecagent-prompted-adapted-import', 'source': source_identity('injecagent'),
            'import_evidence': import_evidence, 'prompt_type': prompt_type,
            'configured_keel_model': getattr(client, 'model', None),
            'measurement': 'upstream-parsed-action-intent', 'actual_sink_success': None, 'benign_utility': None,
            'status': 'failed' if failed else 'completed', 'scores': scores, 'counts': _counts(rows),
            'rows': rows, 'simulator_events': simulator_events, 'upstream_diagnostics': diagnostics.evidence()}

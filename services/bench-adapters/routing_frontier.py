"""Task 10 routing frontier and gate reports from recorded local BFCL runs (CPU only).

cheap-first is replayed from the cheap and strong runs: at temperature 0 the strong
model's answer does not depend on whether the cheap one ran first, so escalating a task
costs exactly the cheap call plus the strong call that was recorded for it.
Cost is model GPU time (sum of call latencies, one request at a time on one RTX 4090);
API price for local models is $0, and no GPU dollar rate is assumed.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / '.tools/benchmark-artifacts'
TYPES = {'string': (str,), 'integer': (int,), 'float': (int, float), 'number': (int, float),
         'boolean': (bool,), 'array': (list,), 'tuple': (list,), 'dict': (dict,), 'object': (dict,)}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()


def load_jsonl(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def latest(rows):
    """Latest attempt per BFCL job, keyed by task id."""
    chosen = {}
    for row in rows:
        if row.get('benchmark') == 'bfcl' and row['attempt'] >= chosen.get(row['task_id'], {}).get('attempt', 0):
            chosen[row['task_id']] = row
    return chosen


def schema_verifier(functions, response):
    """Accept the cheap answer only if it is a schema-valid call. Uses what the model saw, never the answer key."""
    if not isinstance(response, list) or not response:
        return False, 'no_call'
    schemas = {}
    for function in functions:
        schemas[function['name']] = schemas[function['name'].replace('.', '_')] = function.get('parameters', {})
    for call in response:
        if not isinstance(call, dict) or len(call) != 1:
            return False, 'no_call'
        (name, raw), = call.items()
        if name not in schemas:
            return False, 'unknown_function'
        try:
            args = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError:
            return False, 'bad_json'
        if not isinstance(args, dict):
            return False, 'bad_json'
        properties = schemas[name].get('properties', {})
        if any(key not in args for key in schemas[name].get('required', [])):
            return False, 'missing_required'
        for key, value in args.items():
            if key not in properties:
                return False, 'unknown_parameter'
            spec = properties[key]
            allowed = TYPES.get(spec.get('type'))
            if allowed and (not isinstance(value, allowed) or (isinstance(value, bool) and bool not in allowed)):
                return False, 'wrong_type'
            if 'enum' in spec and value not in spec['enum']:
                return False, 'enum_violation'
    return True, 'ok'


def gpu_ms(row):
    return sum(call.get('latency_ms') or 0 for call in row.get('calls', []))


def tokens(row):
    total = 0
    for call in row.get('calls', []):
        usage = (call.get('accounting') or {}).get('usage') or {}
        total += usage.get('input', 0) + usage.get('output', 0)
    return total


def pareto(points):
    """Deployable policies not dominated on (lower GPU time, more successes)."""
    live = [p for p in points if p.get('deployable', True)]
    return [p for p in live if not any(
        q['gpu_seconds'] <= p['gpu_seconds'] and q['successes'] >= p['successes']
        and (q['gpu_seconds'] < p['gpu_seconds'] or q['successes'] > p['successes']) for q in live)]


def policies(cheap, strong):
    if set(cheap) != set(strong):
        raise ValueError('UNPAIRED_POPULATION')
    tasks = sorted(cheap)
    def summarise(name, picks, deployable=True):
        # picks[task] -> list of (model, row) actually executed; the last one is the answer.
        executed = [row for task in tasks for _, row in picks[task]]
        successes = sum(bool(picks[task][-1][1]['success']) for task in tasks)
        return {'policy': name, 'deployable': deployable, 'tasks': len(tasks), 'successes': successes,
                'success_rate': successes / len(tasks), 'escalated': sum(len(picks[t]) == 2 for t in tasks),
                'gpu_seconds': sum(gpu_ms(r) for r in executed) / 1000, 'tokens': sum(tokens(r) for r in executed),
                'api_cost_usd': sum(r.get('cost_known_usd', 0) for r in executed)}
    table = [
        summarise('cheap-only', {t: [('cheap', cheap[t])] for t in tasks}),
        summarise('cheap-first(schema verifier)', {t: [('cheap', cheap[t])] if cheap[t]['verified'] else [('cheap', cheap[t]), ('strong', strong[t])] for t in tasks}),
        summarise('strong-only', {t: [('strong', strong[t])] for t in tasks}),
        # Upper bound: escalates exactly the tasks the cheap model got wrong (uses the answer key).
        summarise('cheap-first(oracle, not deployable)', {t: [('cheap', cheap[t])] if cheap[t]['success'] else [('cheap', cheap[t]), ('strong', strong[t])] for t in tasks}, False),
    ]
    front = {p['policy'] for p in pareto(table)}
    for p in table:
        p['pareto'] = p['policy'] in front
    return table


def verifier_confusion(cheap):
    counts = {'verified_correct': 0, 'verified_wrong': 0, 'rejected_correct': 0, 'rejected_wrong': 0}
    for row in cheap.values():
        counts[('verified_' if row['verified'] else 'rejected_') + ('correct' if row['success'] else 'wrong')] += 1
    return counts


def gate_report(manifest, rows):
    """packages/evals Report for one run of the 400-task BFCL regression population."""
    tasks = sorted(rows, key=lambda t: rows[t]['job_id'])
    if len(tasks) != len(manifest['jobs']):
        raise ValueError('INCOMPLETE_POPULATION')
    model = manifest['model']
    settings = {k: model[k] for k in ('temperature', 'thinking', 'tool_parser', 'max_tokens')}
    status = {'completed': 'completed', 'failed': 'failed', 'invalid': 'incomplete', 'incomplete': 'incomplete'}
    prompts = [manifest.get('prompt_variant', 'original')] + [c.get('prompt_hash') for t in tasks for c in rows[t].get('calls', [])]
    return {
        'execution': {'implementation': manifest['implementation']['sha256'], 'prompt': digest(prompts),
                      'policy': 'local-only', 'models': [digest(model)]},
        'population': {'dataset': manifest['dataset_commits']['bfcl'], 'protocol': 'bfcl-v4-simple_python-single-turn',
                       'scorer': 'BFCL-AST:' + manifest['dataset_commits']['bfcl'] + ':underscore_to_dot',
                       'settings': digest(settings), 'seed': 0},
        'runs': [{'id': t, 'runId': rows[t]['run_id'], 'taskHash': rows[t]['task_hash'], 'status': status[rows[t]['status']],
                  'success': bool(rows[t]['success']) and rows[t]['status'] == 'completed',
                  'costUsd': rows[t]['cost_known_usd'], 'costStatus': rows[t]['cost_status']} for t in tasks],
    }


def artifact(row, store=None):
    return json.loads(gzip.decompress(((store or ARTIFACTS) / row['artifact']['file']).read_bytes()))['benchmark']


def write_json(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, indent=1, sort_keys=True) + '\n')


def frontier_command(args):
    cheap, strong = latest(load_jsonl(args.cheap)), latest(load_jsonl(args.strong))
    cases = []
    for task, row in cheap.items():
        bench = artifact(row) if row['status'] == 'completed' else None
        row['verified'], reason = schema_verifier(bench['entry']['function'], bench['response']) if bench else (False, 'no_call')
        cases.append({'task_id': task, 'cheap_success': bool(row['success']), 'cheap_verified': row['verified'], 'verifier_reason': reason,
                      'strong_success': bool(strong[task]['success']), 'cheap_gpu_ms': round(gpu_ms(row), 1), 'strong_gpu_ms': round(gpu_ms(strong[task]), 1)})
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / 'cases.jsonl').write_text(''.join(json.dumps(c, sort_keys=True) + '\n' for c in sorted(cases, key=lambda c: c['task_id'])))
    result = {'cheap_model': json.loads(Path(args.cheap_manifest).read_text())['model'],
              'strong_model': json.loads(Path(args.strong_manifest).read_text())['model'],
              'verifier': verifier_confusion(cheap), 'policies': policies(cheap, strong)}
    write_json(out / 'frontier.json', result)
    print(json.dumps(result['policies'], indent=1))


def report_command(args):
    write_json(args.out, gate_report(json.loads(Path(args.manifest).read_text()), latest(load_jsonl(args.results))))


def rescore_command(args):
    import sys
    sys.path.insert(0, str(ROOT / '.tools/bench-upstream/gorilla-6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard'))
    from bfcl_runner import KeelBFCLHandler, evaluate_ast
    handler = KeelBFCLHandler(None)
    rows = latest(load_jsonl(args.results))
    summary = {'results_file': Path(args.results).name, 'tasks': len(rows), 'recorded_successes': 0, 'rescored_successes': 0, 'changed': []}
    for task, row in sorted(rows.items()):
        summary['recorded_successes'] += bool(row['success'])
        if row['status'] != 'completed':
            continue
        bench = artifact(row, Path(args.artifacts) if args.artifacts else None)
        valid = evaluate_ast(handler, bench['entry'], bench['response'], bench['ground_truth'])['valid']
        summary['rescored_successes'] += bool(valid)
        if bool(valid) != bool(row['success']):
            summary['changed'].append(task)
    write_json(args.out, summary)
    print(json.dumps({k: v for k, v in summary.items() if k != 'changed'} | {'changed': len(summary['changed'])}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    f = sub.add_parser('frontier')
    for name in ('cheap-manifest', 'cheap', 'strong-manifest', 'strong', 'out'):
        f.add_argument('--' + name, required=True)
    r = sub.add_parser('report')
    for name in ('manifest', 'results', 'out'):
        r.add_argument(name)
    s = sub.add_parser('rescore')
    for name in ('results', 'out'):
        s.add_argument(name)
    s.add_argument('--artifacts', help='artifact store of the run (default: shared .tools/benchmark-artifacts)')
    args = parser.parse_args()
    {'frontier': frontier_command, 'report': report_command, 'rescore': rescore_command}[args.command](args)

"""Task 8 per-model summary and compact per-job evidence from a run_matrix results stream.
  python benchmark_summary.py <results.jsonl> <out-dir>   -> out-dir/jobs.jsonl, out-dir/summary.json
Uses the latest attempt per job_id; failed/incomplete jobs stay in every denominator."""
import argparse
import json
import math
from pathlib import Path
import statistics


def latest(rows):
    out = {}
    for r in rows:
        if r['job_id'] not in out or r['attempt'] > out[r['job_id']]['attempt']:
            out[r['job_id']] = r
    return out


def compact(r):
    usage = [(c.get('accounting') or {}).get('usage') or {} for c in r.get('calls', [])]
    return {'job_id': r['job_id'], 'benchmark': r['benchmark'], 'cell': r.get('domain') or r.get('category'),
            'task_id': r['task_id'], 'seed': r['seed'], 'attempt': r['attempt'], 'status': r['status'],
            'success': bool(r.get('success')), 'reward': r.get('reward'), 'latency_ms': round(r['latency_ms'], 1),
            'calls': len(r.get('calls', [])), 'input_tokens': sum(u.get('input', 0) for u in usage),
            'output_tokens': sum(u.get('output', 0) for u in usage), 'cost_status': r.get('cost_status'),
            'cost_known_usd': r.get('cost_known_usd', 0)}


def aggregate(jobs):
    lat = sorted(j['latency_ms'] for j in jobs)
    known = all(j['cost_status'] == 'known' for j in jobs)
    subtotal = sum(j['cost_known_usd'] for j in jobs)
    return {'jobs': len(jobs), 'successes': sum(j['success'] for j in jobs),
            'original_evaluations': sum(j['status'] == 'completed' for j in jobs),
            'failed': sum(j['status'] == 'failed' for j in jobs),
            'incomplete': sum(j['status'] not in ('completed', 'failed') for j in jobs),
            'success_rate': sum(j['success'] for j in jobs) / len(jobs),
            'latency_ms': {'mean': round(statistics.fmean(lat), 1), 'median': round(statistics.median(lat), 1),
                           'p95': lat[math.ceil(0.95 * len(lat)) - 1]},
            'input_tokens': sum(j['input_tokens'] for j in jobs), 'output_tokens': sum(j['output_tokens'] for j in jobs),
            'cost': f'${subtotal:g} known' if known else f'unknown; known subtotal ${subtotal:g}'}


def summarize(jobs):
    group = lambda key: {k: aggregate([j for j in jobs if key(j) == k]) for k in sorted({key(j) for j in jobs})}
    return {'benchmarks': group(lambda j: j['benchmark']), 'cells': group(lambda j: f"{j['benchmark']}/{j['cell']}"),
            'tau2_seeds': {k: v for k, v in group(lambda j: f"{j['cell']}/seed{j['seed']}").items()
                           if not k.startswith('simple_python')}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('results', type=Path)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.results.read_text().splitlines() if line.strip()]
    jobs = [compact(r) for _, r in sorted(latest(rows).items())]
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / 'jobs.jsonl').write_text(''.join(json.dumps(j) + '\n' for j in jobs))
    summary = {'model': rows[0]['model'], 'attempt_rows': len(rows), **summarize(jobs)}
    (args.out / 'summary.json').write_text(json.dumps(summary, indent=1) + '\n')
    print(json.dumps(summary['benchmarks'], indent=1))


if __name__ == '__main__':
    main()

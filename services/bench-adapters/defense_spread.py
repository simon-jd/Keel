"""Phase 7: run-to-run spread of the full AgentDojo matrix across repeats (CPU only).

Each repeat is one complete run of the same manifest shape (vLLM batching is not bit-reproducible,
so repeats measure run-to-run spread; they are not seeds). Per repeat, policy and group: utility
without attack, utility under attack and targeted ASR under both overflow conventions (failed
episodes as non-successes, and as attack successes the way AgentDojo's harness scores them), then
the min-max range across repeats.

usage: defense_spread.py --run NAME=rows.jsonl[.gz][,more...] (repeat per run) --policies none,all,all-prov --json out.json
"""
import argparse
import json
from pathlib import Path

from defense_report import cell, load

GROUPS = {'overall': ('workspace', 'travel', 'banking', 'slack'), 'held-out (banking+workspace)': ('banking', 'workspace')}
METRICS = ('utility', 'utilityUnderAttack', 'asr', 'asrIfFailuresSucceed')


def summarize(rows, policies):
    out = {}
    for group, suites in GROUPS.items():
        out[group] = {}
        for policy in policies:
            selected = [r for r in rows if r['policy'] == policy and r['suite'] in suites]
            if not selected:
                raise ValueError(f'NO_ROWS:{policy}:{group}')
            c = cell(selected)
            asr = c['asr']
            out[group][policy] = {'utility': c['utility'], 'utilityUnderAttack': c['utilityUnderAttack'], 'asr': asr,
                                  'asrIfFailuresSucceed': {'k': asr['k'] + asr['failed'], 'n': asr['n'],
                                                           'rate': (asr['k'] + asr['failed']) / asr['n'] if asr['n'] else None},
                                  'failedAttackEpisodes': asr['failed'], 'failedCleanEpisodes': c['utility']['failed']}
    return out


def spread(runs, policies):
    per_run = {name: summarize(rows, policies) for name, rows in runs.items()}
    ranges = {}
    for group in GROUPS:
        ranges[group] = {}
        for policy in policies:
            ranges[group][policy] = {}
            for metric in METRICS:
                values = [per_run[name][group][policy][metric] for name in runs]
                rates = [v['rate'] for v in values]
                ranges[group][policy][metric] = {'k': [v['k'] for v in values], 'n': values[0]['n'], 'min': min(rates), 'max': max(rates),
                                                 'rangePoints': 100 * (max(rates) - min(rates))}
    return {'runs': list(runs), 'policies': list(policies), 'perRun': per_run, 'range': ranges}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='append', required=True)
    parser.add_argument('--policies', default='none,all,all-prov')
    parser.add_argument('--json', type=Path, required=True)
    args = parser.parse_args()
    policies = args.policies.split(',')
    runs = {}
    for spec in args.run:
        name, paths = spec.split('=', 1)
        runs[name] = [r for r in load([Path(p) for p in paths.split(',')]) if r['policy'] in policies]
    result = spread(runs, policies)
    args.json.write_text(json.dumps(result, indent=1))
    for group, cells in result['range'].items():
        print(f'### {group}')
        for policy, metrics in cells.items():
            print(policy, '; '.join(f"{m} {'/'.join(map(str, v['k']))} of {v['n']} (range {v['rangePoints']:.1f} pts)" for m, v in metrics.items()))


if __name__ == '__main__':
    main()

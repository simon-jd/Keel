"""Phase 6 full AgentDojo matrix report from run-full rows.jsonl (CPU only).

Per suite and overall, per policy: utility without attack (clean episodes), utility under
attack and targeted ASR (attack episodes), each as successes / episodes with a Wilson 95%
interval, plus model calls, tokens and latency per episode and the guard denials.
Failed episodes (transport or model-action errors) stay in every denominator as
non-successes; their count is reported, and the ASR upper bound counts them as successes
(AgentDojo's own harness scores such episodes as attack successes).
"""
import argparse
from collections import Counter
import gzip
import json
import math
from pathlib import Path
import statistics

SUITES = ('workspace', 'travel', 'banking', 'slack')


def wilson(successes, n, z=1.959963984540054):
    if n == 0:
        return None, None
    p = successes / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return max(0.0, centre - half), min(1.0, centre + half)


def rate(rows, key):
    n = len(rows); k = sum(1 for r in rows if r.get(key) is True)
    lo, hi = wilson(k, n)
    return {'k': k, 'n': n, 'rate': k / n if n else None, 'lo': lo, 'hi': hi, 'failed': sum(r['status'] != 'completed' for r in rows)}


def cost(rows):
    done = [r for r in rows if r.get('calls') is not None]
    mean = lambda key: statistics.fmean(r[key] for r in done) if done else None
    latency = sorted(r['latencyMs'] for r in done if r.get('latencyMs') is not None)
    return {'episodes': len(done), 'callsPerEpisode': mean('calls'), 'inputTokensPerEpisode': mean('inputTokens'),
            'outputTokensPerEpisode': mean('outputTokens'), 'latencyMsMean': statistics.fmean(latency) if latency else None,
            'latencyMsP50': latency[len(latency) // 2] if latency else None,
            'latencyMsP95': latency[min(len(latency) - 1, int(0.95 * len(latency)))] if latency else None}


def cell(rows):
    clean = [r for r in rows if r['kind'] == 'clean']; attack = [r for r in rows if r['kind'] == 'attack']
    asr = rate(attack, 'attackSuccess')
    upper = asr['k'] + asr['failed']
    return {'utility': rate(clean, 'utility'), 'utilityUnderAttack': rate(attack, 'utility'), 'asr': asr,
            'asrUpperIfFailuresSucceed': upper / asr['n'] if asr['n'] else None, 'cost': cost(rows),
            'blockedEpisodes': sum(bool(r.get('blocked')) for r in rows), 'exhaustedEpisodes': sum(bool(r.get('exhausted')) for r in rows)}


def denial_table(rows):
    """Which guard events deny which tools, over clean episodes (legitimate tasks)."""
    table = Counter(); lost = Counter()
    for r in rows:
        if r['kind'] != 'clean':
            continue
        for d in r.get('denials') or []:
            table[(r['suite'], r['policy'], d['op'], d['decision'], d['tool'])] += 1
        if r.get('utility') is not True and r.get('denials'):
            lost[(r['suite'], r['policy'])] += 1
    return ([{'suite': s, 'policy': p, 'op': o, 'decision': d, 'tool': t, 'events': n} for (s, p, o, d, t), n in sorted(table.items())],
            [{'suite': s, 'policy': p, 'failedCleanTasksWithDenials': n} for (s, p), n in sorted(lost.items())])


def report(rows, groups=None):
    groups = groups or {'overall': SUITES, **{s: (s,) for s in SUITES}}
    policies = list(dict.fromkeys(r['policy'] for r in rows))
    out = {}
    for name, suites in groups.items():
        out[name] = {p: cell([r for r in rows if r['policy'] == p and r['suite'] in suites]) for p in policies}
    denials, lost = denial_table(rows)
    return {'policies': policies, 'groups': out, 'denials': denials, 'cleanFailuresWithDenials': lost,
            'errors': Counter(r.get('errorType') for r in rows if r['status'] != 'completed').most_common()}


def load(paths):
    rows = {}
    for path in paths:
        text = gzip.decompress(Path(path).read_bytes()).decode() if str(path).endswith('.gz') else Path(path).read_text()
        for line in text.splitlines():
            row = json.loads(line); rows[row['jobId']] = row
    return list(rows.values())


def fmt(rate_):
    if not rate_['n']:
        return '—'
    return f"{rate_['k']}/{rate_['n']} ({100 * rate_['rate']:.1f}%, {100 * rate_['lo']:.1f}–{100 * rate_['hi']:.1f})"


def markdown(result):
    lines = []
    for name, cells in result['groups'].items():
        lines += [f'### {name}', '', '| policy | utility (no attack) | utility under attack | targeted ASR | failed | calls/ep | in tok/ep | out tok/ep | latency p50 / p95 ms |',
                  '|---|---|---|---|---:|---:|---:|---:|---:|']
        for policy, c in cells.items():
            k = c['cost']
            lines.append(f"| {policy} | {fmt(c['utility'])} | {fmt(c['utilityUnderAttack'])} | {fmt(c['asr'])} | {c['utility']['failed'] + c['asr']['failed']} | "
                         f"{k['callsPerEpisode']:.2f} | {k['inputTokensPerEpisode']:,.0f} | {k['outputTokensPerEpisode']:,.0f} | {k['latencyMsP50']:,.0f} / {k['latencyMsP95']:,.0f} |")
        lines.append('')
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('rows', nargs='+', type=Path)
    parser.add_argument('--json', type=Path, required=True)
    parser.add_argument('--groups', help='JSON object: group name -> list of suites')
    args = parser.parse_args()
    result = report(load(args.rows), json.loads(args.groups) if args.groups else None)
    args.json.write_text(json.dumps(result, indent=1))
    print(markdown(result))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Phase 7 judge comparison (CPU only): binary judge verdicts against a reference, positive class `fail`.

Scoring (fixed in docs/evidence/judge-calibration.md before any candidate run): an invalid or
missing verdict counts as wrong, i.e. as the label opposite to the reference, in every metric.
Reports kappa with a seeded 2,000-resample bootstrap 95% interval, raw agreement and fail
precision / recall with Wilson 95% intervals.

  judge_compare.py score <reference.jsonl> NAME=verdicts.jsonl ...
  judge_compare.py select <spec.json>      spec: {"current_kappa", "cohort_reference", "human_reference",
                                                   "candidates": {NAME: {"cohort", "human", "thinking", "version"}}}
"""
import json
import math
from pathlib import Path
import random
import sys

FLIP = {'pass': 'fail', 'fail': 'pass'}
MAX_INVALID = 8          # of 400 on the balanced cohort
MAX_HUMAN_INVALID = 6    # of 300 on the human primary set
MARGIN, MIN_PRECISION, TIE = 0.05, 0.80, 0.01


def wilson(k, n, z=1.959963984540054):
    if not n:
        return (None, None)
    p = k / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return (centre - half, centre + half)


def proportion(k, n):
    low, high = wilson(k, n)
    return {'k': k, 'n': n, 'p': k / n if n else None, 'wilson95': [low, high]}


def kappa(pairs):
    n = len(pairs)
    po = sum(a == b for a, b in pairs) / n
    pe = sum((sum(a == l for a, _ in pairs) / n) * (sum(b == l for _, b in pairs) / n) for l in ('pass', 'fail'))
    return None if pe == 1 else (po - pe) / (1 - pe)


def score(reference, verdicts, resamples=2000):
    given = {r['id']: r.get('label') for r in verdicts}
    pairs, invalid = [], 0
    for row in reference:
        label = given.get(row['id'])
        if label not in FLIP:
            invalid += 1
            label = FLIP[row['label']]
        pairs.append((row['label'], label))
    count = lambda ref, judge: sum(1 for a, b in pairs if a == ref and b == judge)
    tp, fn, fp, tn = count('fail', 'fail'), count('fail', 'pass'), count('pass', 'fail'), count('pass', 'pass')
    rng, boot = random.Random(0), []
    for _ in range(resamples):
        value = kappa([pairs[rng.randrange(len(pairs))] for _ in pairs])
        if value is not None:
            boot.append(value)
    boot.sort()
    ci = [boot[int(0.025 * len(boot))], boot[min(len(boot) - 1, int(0.975 * len(boot)))]] if boot else [None, None]
    return {'n': len(pairs), 'invalid': invalid, 'kappa': kappa(pairs), 'kappa_ci': ci, 'matrix': [[tp, fn], [fp, tn]],
            'agreement': proportion(tp + tn, len(pairs)), 'fail_precision': proportion(tp, tp + fp), 'fail_recall': proportion(tp, tp + fn)}


def select(candidates, current_kappa):
    ineligible = sorted(name for name, c in candidates.items() if c['invalid'] > MAX_INVALID or c['human_invalid'] > MAX_HUMAN_INVALID)
    eligible = {name: c for name, c in candidates.items() if name not in ineligible and c['kappa'] is not None}
    if not eligible:
        return {'winner': None, 'replace': False, 'ineligible': ineligible}
    best = max(c['kappa'] for c in eligible.values())
    close = [name for name, c in eligible.items() if best - c['kappa'] < TIE]
    close.sort(key=lambda n: (-(eligible[n]['fail_recall']['p'] or 0), eligible[n]['thinking'], eligible[n]['version'], n))
    winner = eligible[close[0]]
    replace = winner['kappa'] >= round(current_kappa + MARGIN, 6) and (winner['fail_precision']['p'] or 0) >= MIN_PRECISION
    return {'winner': close[0], 'replace': replace, 'ineligible': ineligible, 'within_tie': close,
            'rule': f'eligible: invalid <= {MAX_INVALID}/400 and <= {MAX_HUMAN_INVALID}/300; highest cohort kappa; '
                    f'within {TIE}: higher fail recall, non-thinking, lexical version; replace only if kappa >= current + {MARGIN} '
                    f'and fail precision >= {MIN_PRECISION}'}


def read_jsonl(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def main(argv):
    if len(argv) >= 3 and argv[0] == 'score':
        reference = read_jsonl(argv[1])
        result = {name: score(reference, read_jsonl(path)) for name, path in (a.split('=', 1) for a in argv[2:])}
    elif len(argv) == 2 and argv[0] == 'select':
        spec = json.loads(Path(argv[1]).read_text())
        cohort, human = read_jsonl(spec['cohort_reference']), read_jsonl(spec['human_reference'])
        rows = {}
        for name, c in spec['candidates'].items():
            rows[name] = {'cohort': score(cohort, read_jsonl(c['cohort'])), 'human': score(human, read_jsonl(c['human'])),
                          'thinking': c['thinking'], 'version': c['version']}
        flat = {name: {**r['cohort'], 'human_invalid': r['human']['invalid'], 'thinking': r['thinking'], 'version': r['version']}
                for name, r in rows.items() if not spec['candidates'][name].get('baseline')}
        result = {'candidates': rows, 'selection': select(flat, spec['current_kappa'])}
    else:
        print(__doc__, file=sys.stderr)
        return 2
    print(json.dumps(result, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

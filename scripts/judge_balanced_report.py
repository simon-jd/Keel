#!/usr/bin/env python3
"""Task 9 phase 6: judge verdicts vs the BFCL checker on the balanced cohort (CPU only).

Reference = official BFCL AST checker verdict (not human). A judge verdict that failed to
parse stays in the population: it counts as a disagreement for raw agreement and as a miss
for fail recall; kappa is reported on the parsed verdicts. Positive class for fail detection:
`fail`. Selection rule (the Task 9 rule in packages/evals/src/calibration.ts): every version
needs complete coverage and a defined kappa; highest kappa wins, ties broken lexically.

`formattingOnly` marks a checker failure whose call matches one of the possible answers
after normalization (case, punctuation and whitespace in strings; numeric value equality;
dotted vs underscored function names). It is a note: the checker label is never changed.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import re


def kappa(pairs):
    n = len(pairs)
    if not n:
        return None
    po = sum(a == b for a, b in pairs) / n
    labels = {x for p in pairs for x in p}
    pe = sum((sum(a == l for a, _ in pairs) / n) * (sum(b == l for _, b in pairs) / n) for l in labels)
    return None if pe == 1 else (po - pe) / (1 - pe)


def norm(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return re.sub(r'[\s\W_]+', '', value.lower())
    if isinstance(value, list):
        return tuple(norm(v) for v in value)
    if isinstance(value, dict):
        return tuple(sorted((k, norm(v)) for k, v in value.items()))
    return value


def formatting_only(action, ground_truth):
    """True if each call matches a ground-truth function after normalization (order-free)."""
    calls = action.get('toolCalls') or []
    if not ground_truth or len(calls) != len(ground_truth):
        return False
    remaining = list(ground_truth)
    for call in calls:
        name = call['name'].replace('.', '_')
        match = None
        for i, option in enumerate(remaining):
            (gname, params), = option.items()
            if gname.replace('.', '_') != name:
                continue
            args = call.get('args') or {}
            if set(args) - set(params):
                continue
            ok = all(norm(args[p]) in {norm(v) for v in allowed} if p in args else '' in allowed for p, allowed in params.items())
            if ok:
                match = i; break
        if match is None:
            return False
        remaining.pop(match)
    return True


def version_report(reference, audit, samples, rows):
    truth = {r['id']: r['label'] for r in reference}
    verdict = {r['id']: r['label'] for r in rows}
    ids = [r['id'] for r in reference]
    labeled = [(truth[i], verdict[i]) for i in ids if verdict.get(i) in ('pass', 'fail')]
    confusion = Counter(f'reference_{t}_judge_{verdict.get(i) or "invalid"}' for i in ids for t in [truth[i]])
    tp = confusion['reference_fail_judge_fail']; fp = confusion['reference_pass_judge_fail']
    fails = sum(t == 'fail' for t in truth.values())
    by_category = {}
    for category in sorted({a['category'] for a in audit.values()}):
        cids = [i for i in ids if audit[i]['category'] == category]
        pairs = [(truth[i], verdict[i]) for i in cids if verdict.get(i) in ('pass', 'fail')]
        by_category[category] = {'n': len(cids), 'agree': sum(truth[i] == verdict.get(i) for i in cids), 'kappa': kappa(pairs),
                                 'failCaught': sum(truth[i] == 'fail' and verdict.get(i) == 'fail' for i in cids),
                                 'fails': sum(truth[i] == 'fail' for i in cids)}
    disagreements = []
    for i in ids:
        if verdict.get(i) == truth[i]:
            continue
        a = audit[i]
        disagreements.append({'id': i, 'category': a['category'], 'model': a['model'], 'taskId': a['taskId'], 'checker': truth[i],
                              'judge': verdict.get(i) or 'invalid', 'checkerErrorType': a.get('errorType'),
                              'formattingOnly': truth[i] == 'fail' and formatting_only(samples[i]['action'], a.get('groundTruth'))})
    return {'n': len(ids), 'parsed': len(labeled), 'invalid': len(ids) - len(labeled), 'kappa': kappa(labeled),
            'rawAgreement': sum(truth[i] == verdict.get(i) for i in ids) / len(ids),
            'confusion': dict(sorted(confusion.items())),
            'failPrecision': tp / (tp + fp) if tp + fp else None, 'failRecall': tp / fails if fails else None,
            'byCategory': by_category, 'disagreements': disagreements}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cohort', type=Path); parser.add_argument('judge', type=Path)
    parser.add_argument('--versions', default='v1,v2')
    args = parser.parse_args()
    read = lambda p: [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
    reference = read(args.cohort / 'reference.jsonl')
    audit = {a['id']: a for a in read(args.cohort / 'audit.jsonl')}
    samples = {s['id']: s for s in read(args.cohort / 'samples.jsonl')}
    versions = {v: version_report(reference, audit, samples, read(args.judge / f'{v}.jsonl')) for v in args.versions.split(',')}
    eligible = sorted((v for v, r in versions.items() if r['invalid'] == 0 and r['kappa'] is not None), key=lambda v: (-versions[v]['kappa'], v))
    result = {'reference': 'BFCL AST checker verdict (objective, not human)', 'versions': versions,
              'selected': eligible[0] if eligible else None, 'eligible': eligible}
    print(json.dumps(result, indent=1))


if __name__ == '__main__':
    main()

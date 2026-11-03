#!/usr/bin/env python3
"""Task 9 phase 6: a balanced BFCL judge-calibration cohort.

The reference label is the official BFCL AST checker verdict on each stored model output
(pass = checker valid), not a human label. Population: single-turn BFCL outputs already
stored by local runs (each source: results.jsonl + artifact directory). Each output is
blinded exactly as the human-labelled Task 9 cohort (`annotation_material.blind_unit`).

Selection rule (fixed before any judge run): identical blinded units are kept once; per
category take PER_STRATUM checker passes and PER_STRATUM checker fails, ordered by
sha256(f'{PROTOCOL}:{category}:{label}:{content hash}'). If a category has fewer fails (or
passes) than PER_STRATUM, it contributes all it has and the shortfall is taken from the other
categories in the same hash order, so the cohort stays 200 pass / 200 fail.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from annotation_material import artifact, blind_unit, encoded, sha  # noqa: E402

PROTOCOL = 'keel-bfcl-balanced-cohort-20261030'
CATEGORIES = ('simple_python', 'multiple', 'parallel', 'parallel_multiple')
PER_STRATUM = 50


SKIPPED = {}


def population(sources):
    """Outputs the Task 9 blinding cannot present as one complete action (e.g. invalid tool calls)
    are left out, as in the human-labelled cohort; their count per reason is printed."""
    units = {}
    for results, artifacts in sources:
        for line in Path(results).read_text().splitlines():
            row = json.loads(line)
            if row.get('benchmark') != 'bfcl' or row.get('status') != 'completed' or row.get('success') not in (True, False):
                continue
            value = artifact(row, Path(artifacts))
            try:
                unit = blind_unit(value)
            except ValueError as error:
                key = (row['category'], 'pass' if row['success'] else 'fail', str(error))
                SKIPPED[key] = SKIPPED.get(key, 0) + 1
                continue
            digest = sha(encoded(unit))
            label = 'pass' if row['success'] else 'fail'
            if digest in units:
                # The same blinded output from two runs must carry the same checker verdict.
                if units[digest]['label'] != label:
                    raise ValueError('CHECKER_DISAGREES_ON_IDENTICAL_UNIT')
                continue
            units[digest] = {'unit': unit, 'label': label, 'category': row['category'], 'taskId': row['task_id'],
                             'model': row['model']['name'], 'errorType': row.get('error_type'), 'runId': row['run_id'],
                             'source': str(results),
                             # Audit only (never in the blinded sample): checker detail and possible answers.
                             'checkerError': (value['benchmark'].get('verdict') or {}).get('error'),
                             'groundTruth': value['benchmark'].get('ground_truth')}
    return units


def select(units, per_stratum=PER_STRATUM):
    order = lambda item: (sha(f'{PROTOCOL}:{item[1]["category"]}:{item[1]["label"]}:{item[0]}'.encode()), item[0])
    chosen = []
    for label in ('pass', 'fail'):
        pools = {c: sorted(((d, u) for d, u in units.items() if u['category'] == c and u['label'] == label), key=order) for c in CATEGORIES}
        take = {c: pools[c][:per_stratum] for c in CATEGORIES}
        shortfall = per_stratum * len(CATEGORIES) - sum(len(v) for v in take.values())
        spare = sorted((x for c in CATEGORIES for x in pools[c][per_stratum:]), key=order)
        if shortfall > len(spare):
            raise ValueError('INSUFFICIENT_' + label.upper())
        chosen += [x for c in CATEGORIES for x in take[c]] + spare[:shortfall]
    return chosen


def write(chosen, out, population_stats=None):
    out.mkdir(parents=True, exist_ok=False)
    samples, reference, audit = [], [], []
    for digest, unit in sorted(chosen, key=lambda x: sha(f'{PROTOCOL}:id:{x[0]}'.encode())):
        identity = sha(f'{PROTOCOL}:blind:{digest}'.encode())
        samples.append({'id': identity, **unit['unit']})
        reference.append({'id': identity, 'label': unit['label'], 'origin': 'bfcl-checker'})
        audit.append({'id': identity, 'contentHash': digest, **{k: unit.get(k) for k in ('category', 'taskId', 'model', 'label', 'errorType', 'runId', 'source', 'checkerError', 'groundTruth')}})
    files = {}
    for name, rows in (('samples.jsonl', samples), ('reference.jsonl', reference), ('audit.jsonl', audit)):
        data = ''.join(json.dumps(r, ensure_ascii=False, sort_keys=True) + '\n' for r in rows).encode()
        (out / name).write_bytes(data); files[name] = {'rows': len(rows), 'sha256': hashlib.sha256(data).hexdigest()}
    counts = {}
    for a in audit:
        counts.setdefault(a['category'], {'pass': 0, 'fail': 0})[a['label']] += 1
    freeze = {'protocol': PROTOCOL, 'perStratum': PER_STRATUM, 'categories': list(CATEGORIES), 'reference': 'official BFCL AST checker verdict (not human)',
              'counts': counts, 'population': population_stats, 'skipped': {'/'.join(k): v for k, v in sorted(SKIPPED.items())}, 'models': sorted({a['model'] for a in audit}), 'ids': [s['id'] for s in samples], 'files': files,
              'cohortHash': hashlib.sha256('\n'.join(s['id'] for s in samples).encode()).hexdigest()}
    (out / 'freeze.json').write_text(json.dumps(freeze, indent=1) + '\n')
    return freeze


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('out', type=Path)
    parser.add_argument('--source', nargs=2, action='append', required=True, metavar=('RESULTS', 'ARTIFACTS'))
    args = parser.parse_args()
    units = population(args.source)
    stats = {}
    for u in units.values():
        stats.setdefault(u['category'], {'pass': 0, 'fail': 0})[u['label']] += 1
    print(json.dumps({'population': stats, 'skipped': {'/'.join(k): v for k, v in sorted(SKIPPED.items())}}))
    freeze = write(select(units), args.out, stats)
    print(json.dumps({k: freeze[k] for k in ('counts', 'cohortHash', 'files')}))


if __name__ == '__main__':
    main()

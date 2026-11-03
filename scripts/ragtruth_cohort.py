#!/usr/bin/env python3
"""Phase 7 grounding-judge validation cohort from RAGTruth (human hallucination spans), CPU only.

Source: ParticleMedia/RAGTruth (MIT), dataset/response.jsonl + dataset/source_info.jsonl at a pinned
commit, fetched through api.github.com git blobs and checked against their git blob ids.
Protocol `keel-ragtruth-qa-20261031` (fixed before any judge run):
  population: task_type QA, split test, quality "good";
  reference:  fail if the response has any human-annotated hallucination span (including spans
              flagged implicit_true: true but not supported by the passages), else pass;
  selection:  every fail, and the same number of passes in ascending sha256(SALT + id) order.

usage: ragtruth_cohort.py <response.jsonl> <source_info.jsonl> <out-dir>
"""
import hashlib
import json
from pathlib import Path
import sys

SALT = 'keel-ragtruth-qa-20261031:'


def population(responses, sources):
    rows = []
    for r in responses:
        source = sources[r['source_id']]
        if source['task_type'] != 'QA' or r['split'] != 'test' or r['quality'] != 'good':
            continue
        info = source['source_info']
        rows.append({'id': r['id'], 'label': 'fail' if r['labels'] else 'pass', 'question': info['question'], 'passages': info['passages'],
                     'answer': r['response'], 'model': r['model'], 'spans': [l['label_type'] for l in r['labels']]})
    return rows


def select(rows):
    order = lambda r: hashlib.sha256((SALT + r['id']).encode()).hexdigest()
    fails = sorted((r for r in rows if r['label'] == 'fail'), key=order)
    passes = sorted((r for r in rows if r['label'] == 'pass'), key=order)[:len(fails)]
    return sorted(fails + passes, key=order)


def sample(row):
    return {'id': f"ragtruth-{row['id']}", 'input': {'question': row['question'], 'contexts': [{'id': 'passages', 'text': row['passages']}]},
            'action': {'answer': row['answer']}}


def main(response_path, source_path, out):
    responses = [json.loads(l) for l in Path(response_path).read_text().splitlines() if l.strip()]
    sources = {s['source_id']: s for s in (json.loads(l) for l in Path(source_path).read_text().splitlines() if l.strip())}
    pop = population(responses, sources)
    chosen = select(pop)
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    write = lambda name, rows: (out / name).write_text(''.join(json.dumps(r, sort_keys=True) + '\n' for r in rows))
    write('samples.jsonl', [sample(r) for r in chosen])
    write('reference.jsonl', [{'id': f"ragtruth-{r['id']}", 'label': r['label'], 'origin': 'ragtruth-human-spans'} for r in chosen])
    write('audit.jsonl', [{'id': f"ragtruth-{r['id']}", 'model': r['model'], 'spans': r['spans']} for r in chosen])
    digest = lambda name: hashlib.sha256((out / name).read_bytes()).hexdigest()
    freeze = {'protocol': SALT.rstrip(':'), 'population': {'n': len(pop), 'fail': sum(r['label'] == 'fail' for r in pop), 'pass': sum(r['label'] == 'pass' for r in pop)},
              'cohort': {'n': len(chosen), 'fail': sum(r['label'] == 'fail' for r in chosen), 'pass': sum(r['label'] == 'pass' for r in chosen)},
              'files': {n: digest(n) for n in ('samples.jsonl', 'reference.jsonl', 'audit.jsonl')}}
    freeze['cohortHash'] = hashlib.sha256(json.dumps(freeze['files'], sort_keys=True).encode()).hexdigest()
    (out / 'freeze.json').write_text(json.dumps(freeze, indent=1) + '\n')
    print(json.dumps(freeze))


if __name__ == '__main__':
    main(*sys.argv[1:4])

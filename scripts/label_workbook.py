#!/usr/bin/env python3
"""Convert a returned BFCL blind-label workbook into human-label.schema.json JSONL for `label.ts import`.

  python3 scripts/label_workbook.py primary   WORKBOOK.xlsx|SAMPLES.csv OUT.jsonl [--rater NAME]
  python3 scripts/label_workbook.py secondary WORKBOOK.xlsx|SAMPLES.csv OUT.jsonl [--rater NAME] [--primary FILE]

Workbook: sheet `samples` (sample_id, label pass/fail, rationale), sheet `说明` (rater in the cell right of
标注人), hidden sheet `meta` (rubricVersion, cohortHash). A CSV is the `samples` sheet saved as UTF-8 CSV;
it carries no rater or meta, so --rater is required. The .xlsx is read with the standard library
(zipfile + XML): openpyxl is not in any project environment.

Every record gets origin=human, rubricVersion=bfcl-action-v1, the frozen cohort hash, the sheet's rater and
annotatedAt = the workbook's last save time (docProps dcterms:modified, the latest the labels can be from)
when it records one, else the conversion time (UTC); the report says which. The rationale column is not exported: the schema allows no extra keys.
A secondary file is rejected when its rater equals the primary rater (from --primary: a primary JSONL or
workbook; default: the already imported primary labels). OUT is created new with mode 0600; this script
never imports. Then: node_modules/.bin/tsx services/api/src/routes/label.ts import primary|secondary OUT
(OUT must be inside .tools/annotation-task9/).
"""
import argparse
import csv
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import posixpath
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
COHORT = ROOT / '.tools/annotation-task9/cohort.json'
FROZEN = ROOT / 'data/labels/cohort-metadata.json'
RUBRIC = 'bfcl-action-v1'
KEYS = ['id', 'label', 'rater', 'origin', 'rubricVersion', 'cohortHash', 'annotatedAt']
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      'p': 'http://schemas.openxmlformats.org/package/2006/relationships'}


def text(element):
    return ''.join(t.text or '' for t in element.iter(f'{{{NS["m"]}}}t'))


def column_index(ref):
    letters = re.match(r'[A-Z]+', ref).group(0)
    index = 0
    for letter in letters:
        index = index * 26 + ord(letter) - 64
    return index - 1


def read_xlsx(path):
    """sheet name -> rows (lists of cell strings). Shared, inline and numeric cells; hidden sheets included."""
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        shared = []
        if 'xl/sharedStrings.xml' in names:
            shared = [text(si) for si in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('m:si', NS)]
        rels = {rel.get('Id'): rel.get('Target') for rel in ET.fromstring(archive.read('xl/_rels/workbook.xml.rels')).findall('p:Relationship', NS)}
        sheets = {}
        for sheet in ET.fromstring(archive.read('xl/workbook.xml')).find('m:sheets', NS):
            target = rels[sheet.get(f'{{{NS["r"]}}}id')]
            member = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join('xl', target))
            rows = []
            for row in ET.fromstring(archive.read(member)).iter(f'{{{NS["m"]}}}row'):
                cells = {}
                for position, cell in enumerate(row.findall('m:c', NS)):
                    kind, value = cell.get('t'), cell.find('m:v', NS)
                    if kind == 's':
                        content = shared[int(value.text)]
                    elif kind == 'inlineStr':  # openpyxl writes an empty string without <is>
                        inline = cell.find('m:is', NS)
                        content = text(inline) if inline is not None else ''
                    else:
                        content = value.text if value is not None else ''
                    cells[column_index(cell.get('r')) if cell.get('r') else position] = content or ''
                rows.append([cells.get(i, '') for i in range(max(cells) + 1)] if cells else [])
            sheets[sheet.get('name')] = rows
        return sheets


def read_csv(path):
    return list(csv.reader(io.StringIO(Path(path).read_bytes().decode('utf-8-sig'))))


def clean(value):
    return unicodedata.normalize('NFC', str(value)).strip()


def same_person(a, b):
    """Width/case/space-insensitive identity comparison (`Simon D` == `ＳＩＭＯＮ　Ｄ`)."""
    norm = lambda s: ' '.join(unicodedata.normalize('NFKC', s).casefold().split())
    return norm(a) == norm(b)


def samples(rows):
    if not rows:
        raise ValueError('SAMPLES_SHEET_EMPTY')
    # `label\n(pass/fail)` in the coordinator's workbook: keep the leading name.
    header = [re.split(r'[\s(（]', clean(h), maxsplit=1)[0].lower() for h in rows[0]]
    if 'sample_id' not in header or 'label' not in header:
        raise ValueError('SAMPLES_HEADER_REQUIRED: sample_id, label')
    sid, lab = header.index('sample_id'), header.index('label')
    out = []
    for number, row in enumerate(rows[1:], start=2):
        cell = lambda i: clean(row[i]) if i < len(row) else ''
        if not any(clean(v) for v in row):
            continue
        out.append((number, cell(sid), cell(lab).lower()))
    return out


def sheet_rater(rows):
    """标注人 | NAME in adjacent cells, or `标注人：NAME` in one cell."""
    for row in rows:
        for i, value in enumerate(row):
            match = re.fullmatch(r'标注人\s*[:：]?\s*(.*)', clean(value))
            if match:
                rest = [match[1].strip()] if match[1].strip() else [clean(v) for v in row[i + 1:] if clean(v)]
                return rest[0] if rest else None
    return None


def sheet_meta(rows):
    """Key/value rows (A=key, B=value) or one header row with the values below it."""
    keys = ('rubricVersion', 'cohortHash')
    header = [clean(h) for h in rows[0]] if rows else []
    if len(rows) >= 2 and all(k in header for k in keys):
        return {k: clean(v) for k, v in zip(header, rows[1]) if k in keys}
    return {clean(row[0]): clean(row[1]) for row in rows if len(row) >= 2 and clean(row[0]) in keys}


def saved_at(path):
    """The workbook's last save time from docProps/core.xml as ...sssZ, or None."""
    with zipfile.ZipFile(path) as archive:
        if 'docProps/core.xml' not in archive.namelist():
            return None
        node = ET.fromstring(archive.read('docProps/core.xml')).find('{http://purl.org/dc/terms/}modified')
    if node is None or not (node.text or '').strip():
        return None
    when = datetime.fromisoformat(node.text.strip().replace('Z', '+00:00')).astimezone(timezone.utc)
    return when.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def convert(role, source, cohort, rater=None, primary_rater=None, now=None):
    """-> (records, report). Raises ValueError with an upper-case code on any mismatch."""
    if role not in ('primary', 'secondary'):
        raise ValueError('ROLE_REQUIRED')
    source = Path(source)
    if source.suffix.lower() == '.csv':
        kind, rows, named = 'csv', read_csv(source), None
    else:
        kind, sheets = 'xlsx', read_xlsx(source)
        for name in ('samples', '说明', 'meta'):
            if name not in sheets:
                raise ValueError(f'SHEET_MISSING: {name}')
        rows, named = sheets['samples'], sheet_rater(sheets['说明'])
        meta = sheet_meta(sheets['meta'])
        if meta.get('rubricVersion') != RUBRIC or meta.get('cohortHash') != cohort['cohortHash']:
            raise ValueError('META_MISMATCH: workbook rubricVersion/cohortHash differ from the frozen cohort')
    explicit = clean(rater) if rater is not None else None
    if named and explicit and named != explicit:
        raise ValueError('RATER_CONFLICT: --rater differs from the sheet')
    who = named or explicit
    if not who or len(who) > 128:
        raise ValueError('RATER_MISSING: 说明 sheet 标注人 (or --rater for CSV)')
    if role == 'secondary':
        if primary_rater is None:
            raise ValueError('PRIMARY_RATER_UNKNOWN: pass --primary FILE')
        if same_person(who, primary_rater):
            raise ValueError('SECOND_RATER_MUST_BE_INDEPENDENT')
    allowed = cohort['primaryIds' if role == 'primary' else 'secondaryIds']
    allowed_set, seen = set(allowed), set()
    saved = None if now or kind == 'csv' else saved_at(source)
    stamp_source = 'given' if now else 'workbook-saved' if saved else 'conversion'
    stamp = now or saved or datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    records, counts = [], {'pass': 0, 'fail': 0}
    for line, sample_id, label in samples(rows):
        if sample_id not in allowed_set or sample_id in seen:
            raise ValueError(f'UNKNOWN_OR_DUPLICATE_ID: row {line}')
        seen.add(sample_id)
        if label == '':
            continue
        if label not in counts:
            raise ValueError(f'INVALID_LABEL: row {line}')
        counts[label] += 1
        records.append(dict(zip(KEYS, [sample_id, label, who, 'human', RUBRIC, cohort['cohortHash'], stamp])))
    report = {'role': role, 'source': kind, 'rater': who, 'records': len(records), 'labels': counts,
              'missing': len(allowed) - len(records), 'cohortHash': cohort['cohortHash'], 'annotatedAt': stamp,
              'annotatedAtSource': stamp_source}
    return records, report


def primary_rater(source, cohort):
    """Rater of a primary JSONL (converted or imported) or a primary workbook."""
    source = Path(source)
    if source.suffix.lower() == '.jsonl':
        raters = {json.loads(line)['rater'] for line in source.read_text(encoding='utf-8').splitlines() if line.strip()}
        if len(raters) != 1:
            raise ValueError('PRIMARY_RATER_UNKNOWN: primary file has no single rater')
        return raters.pop()
    return convert('primary', source, cohort)[1]['rater']


def load_cohort(path):
    cohort = json.loads(Path(path).read_text())
    frozen = json.loads(FROZEN.read_text())['cohortHash']
    if cohort.get('cohortHash') != frozen or cohort.get('rubricVersion') != RUBRIC:
        raise ValueError('COHORT_NOT_FROZEN: cohort hash differs from data/labels/cohort-metadata.json')
    return cohort


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('role', choices=['primary', 'secondary'])
    parser.add_argument('source', type=Path)
    parser.add_argument('out', type=Path)
    parser.add_argument('--rater', help='required for CSV; must match the sheet for a workbook')
    parser.add_argument('--primary', type=Path, help='primary JSONL or workbook (secondary only)')
    parser.add_argument('--cohort', type=Path, default=COHORT, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        cohort = load_cohort(args.cohort)
        reference = None
        if args.role == 'secondary':
            imported = ROOT / '.tools/annotation-task9/primary.labels.jsonl'
            source = args.primary or (imported if imported.exists() and imported.stat().st_size else None)
            reference = primary_rater(source, cohort) if source else None
        records, report = convert(args.role, args.source, cohort, rater=args.rater, primary_rater=reference)
        fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            out.write(''.join(json.dumps(r, ensure_ascii=False, separators=(',', ':')) + '\n' for r in records))
    except (ValueError, KeyError, OSError, zipfile.BadZipFile, ET.ParseError) as error:
        print(f'label_workbook: {error}', file=sys.stderr)
        return 1
    print(json.dumps({**report, 'out': str(args.out)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())

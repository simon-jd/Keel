"""Human-label workbook converter. Synthetic workbooks only; no real labels are read or imported."""
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from xml.sax.saxutils import escape
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import label_workbook as lw  # noqa: E402

HASH = 'c48c6dff2d6d594125b0260682d31d5a2d1c68ca3448af689cc69d1406e1699f'
PRIMARY = [f'{i:064x}' for i in range(1, 7)]
SECONDARY = PRIMARY[:3]
COHORT = {'cohortHash': HASH, 'rubricVersion': 'bfcl-action-v1', 'primaryIds': PRIMARY, 'secondaryIds': SECONDARY}


def column(index):
    name = ''
    while True:
        index, rest = divmod(index, 26)
        name = chr(65 + rest) + name
        if not index:
            return name
        index -= 1


def write_xlsx(path, sheets, hidden=('meta',), shared=True):
    """Minimal real OOXML workbook: shared strings (as Excel writes) or inline strings, optional hidden sheets."""
    strings = []
    def cell(ref, value):
        if value is None:
            return ''
        if isinstance(value, (int, float)):
            return f'<c r="{ref}"><v>{value}</v></c>'
        if shared:
            strings.append(value)
            return f'<c r="{ref}" t="s"><v>{len(strings) - 1}</v></c>'
        return f'<c r="{ref}" t="inlineStr"><is><t>{escape(value)}</t></is></c>'
    sheet_xml = []
    for rows in sheets.values():
        body = ''.join(f'<row r="{r + 1}">' + ''.join(cell(f'{column(c)}{r + 1}', v) for c, v in enumerate(row)) + '</row>'
                       for r, row in enumerate(rows))
        sheet_xml.append('<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                         f'<sheetData>{body}</sheetData></worksheet>')
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    entries = ''.join(f'<sheet name="{escape(name)}" sheetId="{i + 1}" r:id="rId{i + 1}"' + (' state="hidden"' if name in hidden else '') + '/>'
                      for i, name in enumerate(sheets))
    rels = ''.join(f'<Relationship Id="rId{i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i + 1}.xml"/>'
                   for i in range(len(sheets)))
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr('xl/workbook.xml', f'<?xml version="1.0" encoding="UTF-8"?><workbook {ns}><sheets>{entries}</sheets></workbook>')
        archive.writestr('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                         + rels + '</Relationships>')
        for i, xml in enumerate(sheet_xml):
            archive.writestr(f'xl/worksheets/sheet{i + 1}.xml', xml)
        if shared:
            archive.writestr('xl/sharedStrings.xml', '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                             + ''.join(f'<si><t>{escape(s)}</t></si>' for s in strings) + '</sst>')


def workbook(path, ids, rater='张三', labels=None, meta=None, **kwargs):
    labels = labels or ['pass' if i % 2 else 'fail' for i in range(len(ids))]
    write_xlsx(path, {
        'samples': [['sample_id', 'label', 'rationale'], *[[i, l, f'理由 {n}'] for n, (i, l) in enumerate(zip(ids, labels))]],
        '说明': [['Keel BFCL 盲标'], ['标注人', rater], ['日期', '2026-11-01']],
        'meta': meta or [['rubricVersion', 'bfcl-action-v1'], ['cohortHash', HASH]],
    }, **kwargs)


class WorkbookConverterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='keel-label-test-')
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.now = '2026-11-02T08:30:00.000Z'

    def convert(self, role, source, **kwargs):
        return lw.convert(role, source, COHORT, now=self.now, **kwargs)

    def test_primary_workbook_becomes_schema_records(self):
        for shared in (True, False):
            path = self.dir / f'p{shared}.xlsx'; workbook(path, PRIMARY, shared=shared)
            records, report = self.convert('primary', path)
            schema = json.loads((ROOT / 'data/labels/human-label.schema.json').read_text())
            self.assertEqual(len(records), 6)
            for record, sample_id in zip(records, PRIMARY):
                self.assertEqual(list(record), schema['required'])
                self.assertEqual(record, {'id': sample_id, 'label': record['label'], 'rater': '张三', 'origin': 'human',
                                          'rubricVersion': 'bfcl-action-v1', 'cohortHash': HASH, 'annotatedAt': self.now})
            self.assertEqual(report['labels'], {'pass': 3, 'fail': 3})
            self.assertEqual(report['missing'], 0)

    def test_annotated_headers_of_the_shipped_workbook_are_read(self):
        path = self.dir / 'p.xlsx'
        write_xlsx(path, {
            'samples': [['序号', '用户请求', 'label\n(pass/fail)', 'rationale', 'sample_id'],
                        *[[n + 1, '请求', 'pass', '对', i] for n, i in enumerate(PRIMARY)]],
            '说明': [['标注人', '张三']],
            'meta': [['rubricVersion', 'bfcl-action-v1'], ['cohortHash', HASH]],
        })
        _, report = self.convert('primary', path)
        self.assertEqual(report['labels'], {'pass': 6, 'fail': 0})

    def test_annotated_at_is_the_workbook_save_time_when_it_records_one(self):
        path = self.dir / 'p.xlsx'; workbook(path, PRIMARY)
        with zipfile.ZipFile(path, 'a') as archive:
            archive.writestr('docProps/core.xml', '<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties '
                             'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
                             'xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
                             '<dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-30T04:55:27Z</dcterms:modified></cp:coreProperties>')
        records, report = lw.convert('primary', path, COHORT)
        self.assertEqual({r['annotatedAt'] for r in records}, {'2026-10-30T04:55:27.000Z'})
        self.assertEqual(report['annotatedAtSource'], 'workbook-saved')
        plain = self.dir / 'q.xlsx'; workbook(plain, PRIMARY)
        self.assertEqual(lw.convert('primary', plain, COHORT)[1]['annotatedAtSource'], 'conversion')

    def test_an_empty_inline_string_cell_reads_as_empty(self):
        # openpyxl saves an empty string as <c t="inlineStr"/> without <is>.
        path = self.dir / 'p.xlsx'; workbook(path, PRIMARY, shared=False)
        patched = self.dir / 'patched.xlsx'
        with zipfile.ZipFile(path) as src, zipfile.ZipFile(patched, 'w') as dst:
            for item in src.infolist():
                data = src.read(item)
                if item.filename == 'xl/worksheets/sheet2.xml':
                    data = data.replace(b'</row>', b'<c r="Z1" t="inlineStr"/></row>', 1)
                dst.writestr(item, data)
        _, report = self.convert('primary', patched)
        self.assertEqual(report['rater'], '张三')

    def test_rationale_is_not_exported_because_the_schema_forbids_extra_keys(self):
        path = self.dir / 'p.xlsx'; workbook(path, PRIMARY)
        records, _ = self.convert('primary', path)
        self.assertNotIn('理由', json.dumps(records, ensure_ascii=False))

    def test_blank_labels_are_reported_missing_and_bad_labels_rejected(self):
        path = self.dir / 'p.xlsx'; workbook(path, PRIMARY, labels=[' Pass ', 'FAIL', '', 'pass', 'fail', 'pass'])
        records, report = self.convert('primary', path)
        self.assertEqual([r['label'] for r in records], ['pass', 'fail', 'pass', 'fail', 'pass'])
        self.assertEqual(report['missing'], 1)
        workbook(path, PRIMARY, labels=['pass', 'maybe', 'pass', 'pass', 'pass', 'pass'])
        with self.assertRaisesRegex(ValueError, 'INVALID_LABEL'):
            self.convert('primary', path)

    def test_unknown_duplicate_or_wrong_role_ids_are_rejected(self):
        path = self.dir / 'x.xlsx'
        for ids, role in [([*PRIMARY[:5], 'f' * 64], 'primary'), ([PRIMARY[0], PRIMARY[0]], 'primary'), ([PRIMARY[4]], 'secondary')]:
            workbook(path, ids)
            with self.assertRaisesRegex(ValueError, 'UNKNOWN_OR_DUPLICATE_ID'):
                self.convert(role, path, primary_rater='另一人')

    def test_meta_must_match_the_frozen_cohort_and_rubric(self):
        path = self.dir / 'p.xlsx'
        for meta in ([['rubricVersion', 'bfcl-action-v2'], ['cohortHash', HASH]],
                     [['rubricVersion', 'bfcl-action-v1'], ['cohortHash', '0' * 64]],
                     [['rubricVersion', 'bfcl-action-v1']]):
            workbook(path, PRIMARY, meta=meta)
            with self.assertRaisesRegex(ValueError, 'META_MISMATCH'):
                self.convert('primary', path)
        # Header-row layout of the same hidden sheet is accepted.
        workbook(path, PRIMARY, meta=[['rubricVersion', 'cohortHash'], ['bfcl-action-v1', HASH]])
        self.assertEqual(len(self.convert('primary', path)[0]), 6)

    def test_rater_comes_from_the_sheet_and_must_be_present(self):
        path = self.dir / 'p.xlsx'
        workbook(path, PRIMARY, rater='  李四 ')
        self.assertEqual(self.convert('primary', path)[0][0]['rater'], '李四')
        workbook(path, PRIMARY, rater=None)
        with self.assertRaisesRegex(ValueError, 'RATER_MISSING'):
            self.convert('primary', path)
        write_xlsx(path, {'samples': [['sample_id', 'label'], [PRIMARY[0], 'pass']], '说明': [['标注人：赵六']],
                          'meta': [['rubricVersion', 'bfcl-action-v1'], ['cohortHash', HASH]]})
        self.assertEqual(self.convert('primary', path)[0][0]['rater'], '赵六')

    def test_secondary_rater_must_differ_from_primary(self):
        path = self.dir / 's.xlsx'; workbook(path, SECONDARY, rater='Simon D')
        for same in ['Simon D', ' simon d', 'ＳＩＭＯＮ　Ｄ']:
            with self.assertRaisesRegex(ValueError, 'SECOND_RATER_MUST_BE_INDEPENDENT'):
                self.convert('secondary', path, primary_rater=same)
        with self.assertRaisesRegex(ValueError, 'PRIMARY_RATER_UNKNOWN'):
            self.convert('secondary', path)
        records, _ = self.convert('secondary', path, primary_rater='张三')
        self.assertEqual({r['rater'] for r in records}, {'Simon D'})

    def test_primary_rater_is_read_from_primary_jsonl_or_workbook(self):
        primary = self.dir / 'p.xlsx'; workbook(primary, PRIMARY, rater='张三')
        records, _ = self.convert('primary', primary)
        jsonl = self.dir / 'p.jsonl'; jsonl.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records))
        secondary = self.dir / 's.xlsx'; workbook(secondary, SECONDARY, rater='张三')
        for source in (primary, jsonl):
            with self.assertRaisesRegex(ValueError, 'SECOND_RATER_MUST_BE_INDEPENDENT'):
                self.convert('secondary', secondary, primary_rater=lw.primary_rater(source, COHORT))

    def test_utf8_csv_needs_an_explicit_rater(self):
        path = self.dir / 'samples.csv'
        path.write_bytes('\ufeffsample_id,label,rationale\n'.encode() + ''.join(f'{i},pass,"好, 很好"\n' for i in PRIMARY).encode())
        with self.assertRaisesRegex(ValueError, 'RATER_MISSING'):
            self.convert('primary', path)
        records, report = self.convert('primary', path, rater='王五')
        self.assertEqual(len(records), 6)
        self.assertEqual(report['source'], 'csv')
        self.assertEqual(records[0]['rater'], '王五')

    def test_sheet_rater_and_explicit_rater_must_agree(self):
        path = self.dir / 'p.xlsx'; workbook(path, PRIMARY, rater='张三')
        with self.assertRaisesRegex(ValueError, 'RATER_CONFLICT'):
            self.convert('primary', path, rater='李四')

    def test_cli_writes_a_new_private_file_and_never_overwrites(self):
        cohort = self.dir / 'cohort.json'; cohort.write_text(json.dumps(COHORT))
        path = self.dir / 'p.xlsx'; workbook(path, PRIMARY)
        out = self.dir / 'returned-primary.jsonl'
        command = [sys.executable, str(ROOT / 'scripts/label_workbook.py'), 'primary', str(path), str(out), '--cohort', str(cohort)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(stat.S_IMODE(out.stat().st_mode), 0o600)
        rows = [json.loads(line) for line in out.read_text().splitlines()]
        self.assertEqual(len(rows), 6)
        self.assertRegex(rows[0]['annotatedAt'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$')
        self.assertNotIn('理由', result.stdout)
        again = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertNotEqual(again.returncode, 0)

    def test_cli_rejects_a_cohort_that_is_not_the_frozen_one(self):
        cohort = self.dir / 'cohort.json'; cohort.write_text(json.dumps({**COHORT, 'cohortHash': '1' * 64}))
        path = self.dir / 'p.xlsx'; workbook(path, PRIMARY)
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/label_workbook.py'), 'primary', str(path), str(self.dir / 'o.jsonl'),
                                 '--cohort', str(cohort)], capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('COHORT_NOT_FROZEN', result.stderr)

    def test_output_passes_the_typescript_import_validator(self):
        # Same validator `label.ts import` runs (packages/evals/src/calibration.ts).
        path = self.dir / 'p.xlsx'; workbook(path, PRIMARY)
        records, _ = lw.convert('primary', path, COHORT)
        script = ("import {validateHumanLabels} from './packages/evals/src/calibration.ts';"
                  "const [rows,ids,hash]=JSON.parse(process.argv[1]);validateHumanLabels(rows,ids,hash,'bfcl-action-v1');console.log('ok');")
        result = subprocess.run([str(ROOT / 'node_modules/.bin/tsx'), '-e', script, json.dumps([records, PRIMARY, HASH])],
                                cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.stdout.strip(), 'ok', result.stderr)


if __name__ == '__main__':
    unittest.main()

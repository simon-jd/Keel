import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))

class ProvenanceTests(unittest.TestCase):
    def fixture(self):
        from provenance import canonical_hash
        job={'job_id':0,'benchmark':'tau2','domain':'airline','task_id':'task','task_hash':'task-hash','seed':0}
        manifest={'schema':3,'implementation':{'sha256':'implementation'},'git_sha':'prepared-head','model':{'name':'local'},'dataset_commits':{'tau2':'pin'},'jobs':[job]}
        row={**job,'manifest_hash':canonical_hash(manifest),'implementation_sha256':manifest['implementation']['sha256'],'git_sha':'prepared-head','execution_git_sha':'execution-head','model':manifest['model'],'dataset_commit':'pin','run_id':'run-1','attempt':1,'status':'completed'}
        return manifest,row

    def test_mixed_population_and_row_identity_are_rejected_before_network(self):
        import run_matrix
        from provenance import validate_resume
        manifest,row=self.fixture()
        for key,value in [('manifest_hash','pilot-hash'),('task_hash','other-task'),('seed',1),('domain','telecom'),('dataset_commit','other-pin'),('implementation_sha256','changed')]:
            changed={**row,key:value}
            with self.subTest(key=key),patch.object(run_matrix,'KeelClient') as client:
                with self.assertRaises(ValueError):validate_resume(manifest,[changed])
                client.assert_not_called()
        full=copy.deepcopy(manifest);full['jobs'][0]['task_id']='full-task'
        with self.assertRaises(ValueError):validate_resume(full,[row])

    def test_only_incomplete_or_invalid_attempts_can_repeat_and_all_cost_rows_remain(self):
        from provenance import validate_resume
        manifest,row=self.fixture()
        incomplete={**row,'status':'incomplete'}
        finished={**row,'attempt':2,'run_id':'run-2'}
        done,attempts=validate_resume(manifest,[incomplete,finished])
        self.assertEqual(done,{0});self.assertEqual(attempts,{0:2})
        for rows in [[row,row],[incomplete,{**finished,'attempt':3}],[incomplete,{**finished,'run_id':'run-1'}]]:
            with self.assertRaises(ValueError):validate_resume(manifest,rows)

    def test_run_checks_execution_before_appending_or_constructing_client(self):
        import run_matrix
        manifest,_=self.fixture()
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'manifest.json';path.write_text(json.dumps(manifest));results=Path(tmp)/'results.jsonl'
            with patch.object(run_matrix,'execution_identity',return_value={'implementation':{'sha256':'changed'},'git_sha':'new-head'}),patch.object(run_matrix,'KeelClient') as client:
                with self.assertRaisesRegex(ValueError,'EXECUTION_IDENTITY_DRIFT'):run_matrix.run(path,results,1)
                client.assert_not_called();self.assertFalse(results.exists())


class ImplementationIdentityTests(unittest.TestCase):
    def test_doc_only_changes_are_allowed_but_actual_production_drift_is_rejected(self):
        from provenance import execution_identity
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'services').mkdir();code=root/'services/main.py';code.write_text('value=1\n')
            def git(*args):return subprocess.check_output(['git',*args],cwd=root,stderr=subprocess.DEVNULL)
            git('init');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture')
            git('add','.');git('commit','-m','fixture')
            first=execution_identity(root)
            (root/'README.md').write_text('documentation only')
            git('add','.');git('commit','-m','docs')
            second=execution_identity(root)
            self.assertEqual(first['implementation'],second['implementation'])
            self.assertNotEqual(first['git_sha'],second['git_sha'])
            code.write_text('value=2\n')
            with self.assertRaisesRegex(ValueError,'DIRTY_PRODUCTION'):execution_identity(root)
            git('add','.');git('commit','-m','code')
            third=execution_identity(root)
            self.assertNotEqual(first['implementation'],third['implementation'])
            (root/'services/new.py').write_text('untracked=True')
            with self.assertRaisesRegex(ValueError,'DIRTY_PRODUCTION'):execution_identity(root)

    def test_run_rejects_pilot_results_before_append_or_client(self):
        import run_matrix
        fixture=ProvenanceTests();manifest,row=fixture.fixture()
        row['manifest_hash']='different-pilot'
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'manifest.json';path.write_text(json.dumps(manifest))
            results=Path(tmp)/'results.jsonl';original=json.dumps(row)+'\n';results.write_text(original)
            with patch.object(run_matrix,'execution_identity',return_value={'implementation':manifest['implementation'],'git_sha':'actual-head'}),patch.object(run_matrix,'KeelClient') as client:
                with self.assertRaisesRegex(ValueError,'RESULT_MANIFEST_DRIFT'):run_matrix.run(path,results,1)
                client.assert_not_called();self.assertEqual(results.read_text(),original)

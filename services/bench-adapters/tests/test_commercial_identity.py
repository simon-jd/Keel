"""Real temporary Git histories for prepared/executed provenance, no model/network."""
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))

class CommercialIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        (self.root/'services').mkdir();self.code=self.root/'services/main.py';self.code.write_text('value=1\n')
        self.git('init');self.git('config','user.email','fixture@example.invalid');self.git('config','user.name','Fixture');self.commit('initial')
    def git(self,*args,input=None):return subprocess.check_output(['git',*args],cwd=self.root,input=input,text=True,stderr=subprocess.DEVNULL).strip()
    def commit(self,message):self.git('add','.');self.git('commit','-m',message);return self.git('rev-parse','HEAD')
    def plan(self,execution):
        return dict(schema=3,git_sha=execution['git_sha'],implementation=execution['implementation'],binding=dict(endpoint='https://west-fixture.openai.azure.com/openai/v1',deployment='fixture-mini',quote_id='fixture',region='westus'),model={'region':'westus'},jobs=[{'job_id':0,'seed':0}],dataset_files={'fixture':'hash'},limits={'physical_attempts':10})
    def test_real_docs_only_saved_commit_is_proven_and_manifest_remains_original(self):
        import commercial_bfcl as commercial
        from provenance import execution_identity
        prepared=execution_identity(self.root)
        plan=commercial.manifest(prepared,'https://west-fixture.openai.azure.com/openai/v1','fixture-mini','fixture-retail',region='westus')
        (self.root/'fee.md').write_text('docs-only fee evidence');self.commit('fee documents')
        actual=execution_identity(self.root)
        self.assertNotEqual(prepared['git_sha'],actual['git_sha']);self.assertEqual(prepared['implementation'],actual['implementation'])
        original=deepcopy(plan)
        commercial.verify_commercial_manifest(plan,actual,region='westus',root=self.root)
        self.assertEqual(plan,original);self.assertEqual(plan['git_sha'],prepared['git_sha']);self.assertEqual(actual['git_sha'],self.git('rev-parse','HEAD'))
        class Client:
            run_id='fixture-run';records=[];calls=0;exchanges=[]
        class Store:
            def write(self,*args):return {'file':'fixture-private'}
        from keel_client import AdmissionStop
        with patch.object(commercial,'execute',side_effect=AdmissionStop('BUDGET_EXHAUSTED')):
            commercial.run_jobs(plan,self.root/'results.jsonl',Client,Store(),actual,interval_seconds=0)
        row=json.loads((self.root/'results.jsonl').read_text())
        self.assertEqual(row['git_sha'],prepared['git_sha']);self.assertEqual(row['execution_git_sha'],actual['git_sha'])
        self.assertEqual(row['status'],'incomplete');self.assertNotIn('reward',row)
    def test_unknown_malformed_future_unrelated_and_wrong_code_saved_sha_are_rejected(self):
        import commercial_bfcl as commercial
        from provenance import execution_identity
        first=execution_identity(self.root)
        (self.root/'fee.md').write_text('docs');self.commit('docs')
        current=execution_identity(self.root)
        unrelated=self.git('commit-tree','HEAD^{tree}','-m','unrelated')
        (self.root/'future.md').write_text('future docs');future=self.commit('future docs');self.git('reset','--hard',current['git_sha'])
        for sha in ('bad',current['git_sha'][:7],'f'*40,future,unrelated):
            with self.subTest(sha=sha),patch.object(commercial,'manifest',return_value=self.plan(current)):
                with self.assertRaises(ValueError):commercial.verify_commercial_manifest({**self.plan(current),'git_sha':sha},current,region='westus',root=self.root)
        self.code.write_text('value=2\n');self.commit('changed production');changed=execution_identity(self.root)
        with patch.object(commercial,'manifest',return_value=self.plan(changed)):
            # A forged current implementation field cannot legitimize an old wrong-code SHA.
            with self.assertRaises(ValueError):commercial.verify_commercial_manifest({**self.plan(changed),'git_sha':first['git_sha']},changed,region='westus',root=self.root)
    def test_every_non_git_provenance_field_stays_exact_and_current_code_must_be_clean(self):
        import commercial_bfcl as commercial
        from provenance import execution_identity
        prepared=execution_identity(self.root);plan=self.plan(prepared)
        (self.root/'fee.md').write_text('docs');self.commit('docs');current=execution_identity(self.root)
        mutations=[{'implementation':{'sha256':'forged'}},{'dataset_files':{'fixture':'changed'}},{'jobs':[{'job_id':0,'seed':1}]},{'limits':{'physical_attempts':11}},{'binding':{**plan['binding'],'region':'eastus'}},{'model':{'region':'eastus'}}]
        for mutation in mutations:
            with self.subTest(mutation=mutation),patch.object(commercial,'manifest',return_value=self.plan(current)):
                with self.assertRaises((ValueError,RuntimeError)):commercial.verify_commercial_manifest({**plan,**mutation},current,region='westus',root=self.root)
        self.code.write_text('dirty=1\n')
        with self.assertRaises(ValueError):execution_identity(self.root)
    def test_actual_run_checks_docs_only_proof_before_token_or_network(self):
        import commercial_bfcl as commercial
        from provenance import execution_identity
        prepared=execution_identity(self.root);plan=self.plan(prepared);path=self.root/'manifest.json';path.write_text(json.dumps(plan))
        (self.root/'fee.md').write_text('docs');self.commit('docs');actual=execution_identity(self.root)
        from provenance import verify_prepared_commit
        with patch.object(commercial,'execution_identity',return_value=actual),patch.object(commercial,'manifest',return_value=self.plan(actual)),patch.object(commercial,'verify_prepared_commit',side_effect=lambda plan,execution:verify_prepared_commit(plan,execution,self.root)),patch.object(commercial,'private_token',side_effect=RuntimeError('AFTER_PROOF')) as token:
            with self.assertRaisesRegex(RuntimeError,'AFTER_PROOF'):commercial.run(path,self.root/'result.jsonl',self.root/'token',self.root/'artifacts',region='westus')
            token.assert_called_once();self.assertFalse((self.root/'result.jsonl').exists())
    def test_production_to_excluded_test_rename_cannot_hide_wrong_code_ancestor(self):
        from provenance import execution_identity, verify_prepared_commit, PRODUCTION_ROOTS
        # Keep another production file so snapshot validation itself remains valid.
        (self.root/'services/retained.py').write_text('retained=1\n');self.commit('retain production')
        self.git('config','diff.renames','true');saved=execution_identity(self.root)
        (self.root/'services/tests').mkdir();self.git('mv','services/main.py','services/tests/main.py');self.commit('rename into excluded tests')
        current=execution_identity(self.root)
        self.assertNotEqual(saved['implementation'],current['implementation'])
        detected=self.git('diff','--name-only',saved['git_sha'],current['git_sha'],'--',*PRODUCTION_ROOTS).splitlines()
        self.assertEqual(detected,['services/tests/main.py'])
        # The caller supplies the true current snapshot; saved ancestry must not hide deletion.
        with self.assertRaisesRegex(ValueError,'PREPARED_COMMIT_PRODUCTION_DRIFT'):
            verify_prepared_commit({'git_sha':saved['git_sha']},current,self.root)
    def test_production_rename_and_deletion_reject_while_docs_only_ancestor_passes(self):
        from provenance import execution_identity, verify_prepared_commit
        (self.root/'services/retained.py').write_text('retained=1\n');self.commit('retain production')
        saved=execution_identity(self.root)
        (self.root/'fee.md').write_text('legitimate docs-only');self.commit('docs-only')
        docs=execution_identity(self.root);verify_prepared_commit({'git_sha':saved['git_sha']},docs,self.root)
        self.git('mv','services/main.py','services/renamed.py');self.commit('production rename')
        renamed=execution_identity(self.root)
        with self.assertRaisesRegex(ValueError,'PREPARED_COMMIT_PRODUCTION_DRIFT'):
            verify_prepared_commit({'git_sha':saved['git_sha']},renamed,self.root)
        self.git('rm','services/renamed.py');self.commit('production deletion')
        deleted=execution_identity(self.root)
        with self.assertRaisesRegex(ValueError,'PREPARED_COMMIT_PRODUCTION_DRIFT'):
            verify_prepared_commit({'git_sha':renamed['git_sha']},deleted,self.root)

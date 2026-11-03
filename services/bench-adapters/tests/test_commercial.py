"""Pinned BFCL/first10 fixtures: no provider network and no commercial scores."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))

class CommercialDriverTests(unittest.TestCase):
    def test_fixed_population_real_adapter_serializer_and_new_identity(self):
        self.assertIsNotNone(importlib.util.find_spec('commercial_bfcl'),'separate commercial driver missing')
        import commercial_bfcl as commercial
        plan,requests=commercial.population()
        self.assertEqual(len(plan),10); self.assertEqual(len(requests),10)
        self.assertEqual([j['task_id'] for j in plan],[e['id'] for e in commercial.entries()[:10]])
        self.assertEqual({j['seed'] for j in plan},{0})
        self.assertEqual({r['seed'] for r in requests},{0})
        self.assertTrue(all(r['tools'] and r['messages'] for r in requests))
        self.assertEqual(commercial.provider_hashes(requests,'fixture-mini'),commercial.provider_hashes(requests,'fixture-mini'))
        self.assertNotEqual(commercial.provider_hashes(requests,'fixture-mini'),commercial.provider_hashes(requests,'other-deployment'))
        manifest=commercial.manifest({'git_sha':'fixture-new-code','implementation':{'sha256':'new-commercial-code'}},'https://fixture.openai.azure.com/openai/v1','fixture-mini','fixture-retail-quote')
        self.assertEqual(manifest['implementation']['sha256'],'new-commercial-code')
        self.assertEqual(manifest['model']['version'],'2025-04-14')
        self.assertEqual(manifest['limits']['physical_attempts'],10)
        self.assertEqual(manifest['jobs'],plan)
    def test_actual_original_adapter_and_ast_evaluator_remain_in_path(self):
        import commercial_bfcl as commercial
        class Fixture:
            def step(self,messages,tools):
                self.messages=messages;self.tools=tools
                return {'action':{'content':'','toolCalls':[{'id':'fixture-id','name':'add','args':{'a':2,'b':3}}]},'usage':{'input':1,'output':1},'latency_ms':1}
        entry={'id':'simple_python_fixture','question':[[{'role':'user','content':'sum'}]],'function':[{'name':'add','description':'sum','parameters':{'type':'dict','properties':{'a':{'type':'integer'},'b':{'type':'integer'}},'required':['a','b']}}]}
        fixture=Fixture()
        result=commercial.evaluate_entry(entry,{'ground_truth':[{'add':{'a':[2],'b':[3]}}]},fixture)
        self.assertTrue(result['success']);self.assertIn('add',[t['name'] for t in fixture.tools])
    def test_exhausted_driver_stops_and_keeps_planned_denominator_unscored(self):
        import commercial_bfcl as commercial
        from keel_client import AdmissionStop
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)
            manifest={'jobs':[{'job_id':i,'benchmark':'bfcl','task_id':f'fixed_{i}','seed':0,'task_hash':'fixture'} for i in range(10)],'model':commercial.MODEL,'git_sha':'fixture','implementation':{'sha256':'fixture'},'dataset_commits':{'bfcl':commercial.BFCL_PIN}}
            class Client:
                run_id='fixture-run';records=[{'accounting':{'attempts':[{'outcome':'failed','costStatus':'unknown'}],'costStatus':'unknown','costUsd':0}}];exchanges=[];calls=1
            class Store:
                def write(self,*args):return {'file':'fixture-private-artifact'}
            with patch.object(commercial,'execute',side_effect=AdmissionStop('BUDGET_EXHAUSTED')) as execute:
                summary=commercial.run_jobs(manifest,path/'results.jsonl',lambda:Client(),Store(),{'git_sha':'fixture'},interval_seconds=0)
            self.assertEqual(execute.call_count,1)
            rows=[json.loads(line) for line in (path/'results.jsonl').read_text().splitlines()]
            self.assertEqual(rows[0]['status'],'incomplete');self.assertNotIn('reward',rows[0]);self.assertNotIn('success',rows[0])
            self.assertEqual(summary,{'planned':10,'completed':0,'failed':0,'incomplete':10,'attempted_jobs':1})
            self.assertEqual(rows[0]['cost_status'],'unknown')
    def test_http_budget_rejection_is_typed_and_retains_prior_accounting(self):
        from keel_client import KeelClient,AdmissionStop
        from urllib.error import HTTPError
        import io
        client=KeelClient('http://127.0.0.1:18081','fixture')
        class Opener:
            def open(self,*args,**kwargs):raise HTTPError('http://127.0.0.1:18081',502,'fixture',{},io.BytesIO(json.dumps({'error':'BUDGET_EXHAUSTED','accounting':{'attempts':[],'costUsd':0,'costStatus':'known'}}).encode()))
        client.opener=Opener()
        with self.assertRaisesRegex(AdmissionStop,'BUDGET_EXHAUSTED'):client.step([{'role':'user','content':'fixture'}])
        self.assertEqual(client.records[0]['accounting']['attempts'],[])

    def test_server_binding_drift_stops_before_benchmark_dispatch(self):
        import commercial_bfcl as commercial
        from contextlib import contextmanager
        execution={'git_sha':'fixture','implementation':{'sha256':'fixture'}}
        plan={'schema':3,'git_sha':execution['git_sha'],'implementation':execution['implementation'],'binding':{'endpoint':'https://fixture.openai.azure.com/openai/v1','deployment':'fixture-mini','quote_id':'fixture','region':'eastus'}}
        class Probe:
            endpoint='http://127.0.0.1:18081'
            class Opener:
                @contextmanager
                def open(self,*args,**kwargs):
                    import io
                    yield io.BytesIO(json.dumps({'bindingHash':'wrong','reservationId':'fixture'}).encode())
            opener=Opener()
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory);(path/'manifest.json').write_text(json.dumps(plan))
            with patch.object(commercial,'verify_prepared_commit'),patch.object(commercial,'execution_identity',return_value=execution),patch.object(commercial,'manifest',return_value=plan),patch.object(commercial,'private_token',return_value='fixture'),patch.object(commercial,'KeelClient',return_value=Probe()),patch.object(commercial,'run_jobs') as jobs:
                with self.assertRaisesRegex(RuntimeError,'SERVER_BINDING_DRIFT'):commercial.run(path/'manifest.json',path/'results.jsonl',path/'token',path/'artifacts')
            jobs.assert_not_called();self.assertFalse((path/'results.jsonl').exists())

    def test_trusted_pacing_keeps_exact_job_order_and_does_not_wait_in_fixtures(self):
        import commercial_bfcl as commercial
        order=[];waits=[]
        plan={'jobs':[{'job_id':i,'benchmark':'bfcl','task_id':f'fixed_{i}','seed':0,'task_hash':'fixture'} for i in range(10)],'model':commercial.MODEL,'git_sha':'fixture','implementation':{'sha256':'fixture'}}
        class Client:
            records=[];exchanges=[];calls=0
            def __init__(self):self.run_id='fixture-'+str(len(order))
        class Store:
            def write(self,*args):return {'file':'fixture-private-artifact'}
        def execute(job,client):order.append(job['job_id']);return {'success':True,'reward':1}
        with tempfile.TemporaryDirectory() as directory,patch.object(commercial,'execute',side_effect=execute):
            summary=commercial.run_jobs(plan,Path(directory)/'results.jsonl',Client,Store(),{'git_sha':'fixture'},interval_seconds=20,sleep=waits.append)
        self.assertEqual(order,list(range(10)));self.assertEqual(waits,[20]*9);self.assertEqual(summary['completed'],10)

    def test_driver_token_files_require_owned_regular_nonsymlink_0600(self):
        import commercial_bfcl as commercial
        import os
        with tempfile.TemporaryDirectory(dir=commercial.ROOT/'.secrets',prefix='commercial-fixture-') as directory:
            path=Path(directory)/'token';path.write_text('synthetic-private-token');path.chmod(0o600)
            self.assertEqual(commercial.private_token(path),'synthetic-private-token')
            path.chmod(0o644)
            with self.assertRaises(RuntimeError):commercial.private_token(path)
            path.chmod(0o600);link=Path(directory)/'link';link.symlink_to(path)
            with self.assertRaises(RuntimeError):commercial.private_token(link)
            fifo=Path(directory)/'fifo';os.mkfifo(fifo,0o600)
            with self.assertRaises(RuntimeError):commercial.private_token(fifo)

    def test_explicit_westus_manifest_uses_real_shared_serializer_and_keeps_first10(self):
        import commercial_bfcl as commercial
        execution={'git_sha':'fixture-west-code','implementation':{'sha256':'fixture-west-implementation'}}
        east=commercial.manifest(execution,'https://fixture.openai.azure.com/openai/v1','fixture-mini','fixture-east-quote')
        west=commercial.manifest(execution,'https://west-fixture.openai.azure.com/openai/v1','fixture-mini','fixture-west-quote',region='westus')
        self.assertEqual(east['model']['region'],'eastus');self.assertEqual(commercial.MODEL['region'],'eastus')
        self.assertEqual(west['model']['region'],'westus');self.assertEqual(west['binding']['region'],'westus')
        for key in ('jobs','dataset_files','dataset_commits','implementation','limits'):self.assertEqual(east[key],west[key])
        self.assertEqual(east['binding']['request_hashes'],west['binding']['request_hashes'])
        self.assertEqual(west['binding']['request_hashes'],commercial.provider_hashes(commercial.population()[1],'fixture-mini'))
        for unsupported in ('centralus','swedencentral',''):
            with self.assertRaises(RuntimeError):commercial.manifest(execution,west['binding']['endpoint'],'fixture-mini','fixture-quote',region=unsupported)

    def test_westus_run_requires_explicit_matching_operator_region_before_network(self):
        import commercial_bfcl as commercial
        execution={'git_sha':'fixture','implementation':{'sha256':'fixture'}}
        plan={'schema':3,'git_sha':execution['git_sha'],'implementation':execution['implementation'],'binding':{'endpoint':'https://west-fixture.openai.azure.com/openai/v1','deployment':'fixture-mini','quote_id':'fixture','region':'westus'}}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory);(path/'manifest.json').write_text(json.dumps(plan))
            with patch.object(commercial,'verify_prepared_commit'),patch.object(commercial,'execution_identity',return_value=execution),patch.object(commercial,'manifest',return_value=plan) as regenerated,patch.object(commercial,'private_token',side_effect=RuntimeError('AFTER_MANIFEST')) as token:
                with self.assertRaisesRegex(RuntimeError,'COMMERCIAL_REGION_BINDING_DRIFT'):commercial.run(path/'manifest.json',path/'results.jsonl',path/'token',path/'artifacts')
                token.assert_not_called();regenerated.assert_not_called()
                with self.assertRaisesRegex(RuntimeError,'AFTER_MANIFEST'):commercial.run(path/'manifest.json',path/'results.jsonl',path/'token',path/'artifacts',region='westus')
                self.assertEqual(regenerated.call_args.kwargs,{'region':'westus'})

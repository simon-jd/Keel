"""Fixture-only export behavior; actual retained replay is a separate command."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import contextlib
import io
import tempfile
SPEC=importlib.util.spec_from_file_location('regression_material',Path(__file__).resolve().parents[3]/'scripts/regression_material.py')
module=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)

class RegressionMaterialTests(unittest.TestCase):
    def case(self,i,success=False):
        unit={'input':{'messages':[{'role':'user','content':str(i)}],'tools':[]},'action':{'role':'assistant','content':'','toolCalls':[]}}
        source={'jobId':i,'runId':str(i),'artifact':{'raw_sha256':str(i)}}
        value={'metadata':{'task_id':str(i),'seed':0,'task_hash':str(i),'success':success,'status':'completed'},'benchmark':{'entry':{'id':str(i)},'ground_truth':['answer'],'response':['actual'],'verdict':{'valid':success}},'exchanges':[]}
        return unit,source,value
    def test_deterministic_unique_genuine_failures_and_success_controls(self):
        records=[self.case(i,i>=120) for i in range(200)]
        first=module.select_cases(records);self.assertEqual(first,module.select_cases(list(reversed(records))))
        self.assertEqual(len(first),200);self.assertEqual(sum(not x['originalSuccess'] for x in first),120)
        self.assertEqual(first[0]['original']['benchmark']['ground_truth'],['answer'])
    def test_duplicate_input_actual_output_cannot_manufacture_failures(self):
        records=[self.case(i) for i in range(100)];records.append(records[0])
        with self.assertRaises(ValueError):module.select_cases(records)
    def test_original_ast_and_terminal_status_must_agree(self):
        for change in ('verdict','status','missing','task'):
            record=self.case(1);value=record[2]
            if change=='verdict':value['benchmark']['verdict']['valid']=True
            if change=='status':value['metadata']['status']='incomplete'
            if change=='missing':del value['benchmark']['response']
            if change=='task':value['benchmark']['entry']['id']='other'
            with self.assertRaises((ValueError,KeyError)):module.select_cases([record])
    def test_business_ids_remain_semantic(self):
        first=self.case(1);second=self.case(2)
        second[0]['input']=first[0]['input'];second[0]['action']['content']='business-id'
        self.assertEqual(len(module.select_cases([first,second])),2)

    def test_verify_requires_exact_private_mapping_without_creating_or_mutating_it(self):
        with tempfile.TemporaryDirectory() as d:
            private=Path(d)/'private';private.mkdir(mode=0o700)
            public=Path(d)/'public';public.mkdir()
            case={'id':'source-task','semanticHash':'semantic','taskHash':'source-hash'};secret=b'a'*32
            material=([case],b'private',b'validation',b'failures',b'binding')
            for path,data in [(private/'cases.jsonl',b'private'),(public/'bfcl-validation.jsonl',b'validation'),(public/'bfcl-failures.jsonl',b'failures'),(public/'binding.json',b'binding'),(public/'baseline-report.json',b'baseline'),(public/'baseline-proof.json',b'proof')]:path.write_bytes(data);path.chmod(0o600)
            mapping=module.encoded([{'publicId':module.identity.commit(secret,'case','semantic'),'publicTaskHash':module.identity.commit(secret,'task','source-hash'),'sourceTaskHash':'source-hash','sourceSemanticHash':'semantic','sourceTaskId':'source-task'}])+b'\n'
            with patch.object(module,'PRIVATE',private),patch.object(module,'PUBLIC',public),patch.object(module,'material',return_value=material),patch.object(module,'verify_superseded'),patch.object(module.identity,'key',return_value=secret),patch.object(module,'baseline_files',return_value=(b'baseline',b'proof')),contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(FileNotFoundError):module.export(verify=True)
                self.assertFalse((private/'public-map.json').exists())
                path=private/'public-map.json';path.write_bytes(mapping);path.chmod(0o600)
                before=(path.read_bytes(),path.stat().st_ino,path.stat().st_mtime_ns)
                module.export(verify=True)
                self.assertEqual(before,(path.read_bytes(),path.stat().st_ino,path.stat().st_mtime_ns))
                path.write_bytes(b'changed')
                with self.assertRaises(ValueError):module.export(verify=True)
                self.assertEqual(path.read_bytes(),b'changed')

if __name__=='__main__':unittest.main()

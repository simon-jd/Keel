"""Disposable fixtures only; no human or model evidence."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC=importlib.util.spec_from_file_location('annotation_material',Path(__file__).resolve().parents[3]/'scripts/annotation_material.py')
module=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)

class AnnotationMaterialTests(unittest.TestCase):
    def sample(self,transport='call-1',business='business-7'):
        return {'metadata':{},'human_labels':None,'benchmark':{'ground_truth':'SECRET','verdict':'SECRET'},'exchanges':[{'request':{'messages':[{'role':'user','content':'ask'}],'tools':[{'name':'lookup','parameters':{'id':business}}]},'response':{'action':{'role':'assistant','content':'','toolCalls':[{'id':transport,'name':'lookup','args':{'id':business}}]},'invalidToolCalls':[]}}]}
    def test_blind_complete_and_precise_transport_canonicalization(self):
        first=module.blind_unit(self.sample())
        second=module.blind_unit(self.sample('random-2'))
        self.assertEqual(first,second)
        self.assertNotEqual(first,module.blind_unit(self.sample(business='other')))
        self.assertNotIn('SECRET',json.dumps(first))
        self.assertEqual(first['action']['toolCalls'][0]['args']['id'],'business-7')
        self.assertEqual(set(first),{'input','action'})
    def test_reject_incomplete_and_future_history_instead_of_guessing(self):
        for alter in ('response','history','multi','invalid'):
            sample=self.sample()
            if alter=='response':sample['exchanges'][0]['response']={'error':'MODEL_FAILED'}
            if alter=='history':sample['exchanges'][0]['request']['messages'][0]['role']='assistant'
            if alter=='multi':sample['exchanges']*=2
            if alter=='invalid':sample['exchanges'][0]['response']['invalidToolCalls']=[{}]
            with self.assertRaises(ValueError):module.blind_unit(sample)
    def test_deterministic_selection_and_secondary_subset(self):
        population=[({'input':{'n':n},'action':{'n':n}}, {'job':n}) for n in range(400)]
        a=module.select(population,300,100);b=module.select(list(reversed(population)),300,100)
        self.assertEqual(a,b);self.assertEqual(len(a[0]),300);self.assertEqual(len(a[1]),100)
        self.assertTrue(set(a[1])<=set(x['id'] for x in a[0]))
        with self.assertRaises(ValueError):module.select(population+[population[0]],300,100)
    def test_private_no_symlinks_no_overwrite_and_bounded_read(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);root.chmod(0o700);file=root/'safe'
            module.write_private(file,b'abc');self.assertEqual(file.stat().st_mode&0o777,0o600)
            self.assertEqual(module.read_private(file,3),b'abc')
            with self.assertRaises(ValueError):module.read_private(file,2)
            with self.assertRaises(FileExistsError):module.write_private(file,b'changed')
            (root/'link').symlink_to(file)
            with self.assertRaises(ValueError):module.read_private(root/'link',3)
    def test_historical_identity_ignores_current_production_but_rejects_corrupt_original(self):
        files=[{'path':'packages/example.ts','sha256':'a'*64}]
        original={'schema':3,'implementation':{'files':files,'sha256':module.canonical_hash(files)}}
        module.historical_identity(original)
        original['implementation']['files'].append(files[0])
        with self.assertRaises(ValueError):module.historical_identity(original)

    def test_original_index_prefix_accepts_closed_append_but_rejects_prefix_tamper(self):
        rows=[];entries=[]
        for i in range(311):
            row={'domain':'airline','job_id':i,'run_id':str(i),'attempt':1,'artifact':{'file':str(i)+'.json.gz','compressed_bytes':41_071_806 if i==0 else 0}}
            line=json.dumps(row).encode();rows.append(row)
            entries.append({'basename':row['artifact']['file'],'job_id':i,'run_id':str(i),'attempt':1,'artifact':row['artifact'],'source_line_number':i,'source_line_sha256':module.sha(line)})
        lines=[json.dumps(r).encode() for r in rows];prefix=b'\n'.join(lines)+b'\n';source=prefix+b'{"later":"closed BFCL rows"}\n'
        manifest={'implementation':{'sha256':'frozen'}};raw=b'original-manifest'
        index={'schema':1,'active_root':module.ACTIVE,'archive_root':module.ARCHIVE,'manifest_sha256':module.sha(raw),'implementation_sha256':'frozen','source_snapshot_bytes':len(prefix),'source_prefix_sha256':module.sha(prefix),'entries':entries,'compressed_bytes':41_071_806}
        marker={'schema':1,'index_sha256':module.INDEX_SHA,'artifacts':311,'compressed_bytes':41_071_806}
        module.verify_index(index,marker,source,lines,rows,raw,manifest)
        with self.assertRaises(ValueError):module.verify_index(index,marker,b'X'+source[1:],lines,rows,raw,manifest)
        entries[0]['artifact']={'file':'../escape','compressed_bytes':41_071_806}
        with self.assertRaises(ValueError):module.verify_index(index,marker,source,lines,rows,raw,manifest)
    def test_artifact_checks_hashes_metadata_paths_and_raw_bound(self):
        import gzip
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);root.chmod(0o700);run='12345678-1234-1234-1234-123456789abc'
            row={'run_id':run};value={'metadata':dict(row),'human_labels':None,'exchanges':[]}
            raw=json.dumps(value).encode();compressed=gzip.compress(raw)
            ref={'file':run+'.json.gz','compressed_bytes':len(compressed),'sha256':module.sha(compressed),'raw_bytes':len(raw),'raw_sha256':module.sha(raw)};row['artifact']=ref
            module.write_private(root/ref['file'],compressed)
            self.assertEqual(module.artifact(row,root),value)
            ref['raw_sha256']='0'*64
            with self.assertRaises(ValueError):module.artifact(row,root)
            ref['file']='../escape'
            with self.assertRaises(ValueError):module.artifact(row,root)
            with self.assertRaises(ValueError):module.decode_gzip(gzip.compress(b'x'*33),32)

if __name__=='__main__':unittest.main()

"""Isolated Azure BFCL v4 first10/seed0 driver; no resource creation or provider SDK transport."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import logging
import math
import os
import re
from pathlib import Path
import socket
import stat
import subprocess
import time
from urllib.request import Request
from loguru import logger
logger.remove()
logging.disable(logging.CRITICAL)
from artifacts import ArtifactStore, ArtifactLimit
from bfcl_runner import KeelBFCLHandler, evaluate_ast
from keel_client import KeelClient, AdmissionStop
from provenance import execution_identity, verify_execution, verify_prepared_commit, canonical_hash

ROOT=Path(__file__).resolve().parents[2]
BFCL_PIN='6ea57973c7a6097fd7c5915698c54c17c5b1b6c8'
MODEL={'provider':'azureCommercial','name':'gpt-4.1-mini','version':'2025-04-14','region':'eastus','sku':'GlobalStandard','temperature':0.0,'seed':0,'max_completion_tokens':2048}


def data_path():
    import bfcl_eval
    package=Path(bfcl_eval.__file__).resolve().parent
    expected=ROOT/'.tools/bench-upstream'/('gorilla-'+BFCL_PIN)/'berkeley-function-call-leaderboard/bfcl_eval'
    if package!=expected:raise RuntimeError('BFCL_SOURCE_BINDING_DRIFT')
    lock=json.loads((ROOT/'services/bench-adapters/upstream-lock.json').read_text())
    if lock['bfcl']['commit']!=BFCL_PIN:raise RuntimeError('BFCL_REVISION_DRIFT')
    return package/'data'


def load(path):return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
def entries():return load(data_path()/'BFCL_v4_simple_python.json')


class Captured(BaseException):pass


def population():
    """Use original upstream conversion, then stop at the Keel model boundary offline."""
    jobs=[];requests=[]
    class Capture:
        def step(self,messages,tools):
            requests.append(dict(model='local',messages=messages,tools=tools,temperature=0,seed=0,maxTokens=2048))
            raise Captured()
    for i,entry in enumerate(entries()[:10]):
        try:KeelBFCLHandler(Capture()).inference(entry,include_input_log=False,exclude_state_log=True)
        except Captured:pass
        jobs.append(dict(job_id=i,benchmark='bfcl',category='simple_python',task_id=entry['id'],seed=0,task_hash=canonical_hash(entry)))
    if len(jobs)!=10 or len(requests)!=10:raise RuntimeError('FIRST10_POPULATION_INVALID')
    return jobs,requests


def provider_hashes(requests,deployment):
    # Exact production serializer through models; prompts never appear in argv or stdout.
    command=[str(ROOT/'services/api/node_modules/.bin/tsx'),str(ROOT/'packages/models/src/commercialPrepare.ts')]
    result=subprocess.run(command,input=json.dumps(dict(deployment=deployment,requests=requests)),text=True,capture_output=True,timeout=30,cwd=ROOT)
    if result.returncode:raise RuntimeError('PROVIDER_SERIALIZATION_DENIED')
    return json.loads(result.stdout)


def manifest(execution,endpoint,deployment,quote_id,*,region='eastus'):
    if not re.fullmatch(r'https://[a-z0-9][a-z0-9-]{1,62}\.openai\.azure\.com/openai/v1',endpoint) or not quote_id or region not in ('eastus','westus'):raise RuntimeError('FIXED_AZURE_BINDING_INVALID')
    jobs,requests=population()
    binding=dict(endpoint=endpoint,deployment=deployment,model=MODEL['name'],version=MODEL['version'],region=region,sku=MODEL['sku'],quote_id=quote_id,request_hashes=provider_hashes(requests,deployment))
    return dict(schema=3,kind='commercial-bfcl-first10-seed0',git_sha=execution['git_sha'],implementation=execution['implementation'],dataset_commits={'bfcl':BFCL_PIN},dataset_files={str(p.relative_to(data_path())):hashlib.sha256(p.read_bytes()).hexdigest() for p in (data_path()/'BFCL_v4_simple_python.json',data_path()/'possible_answer/BFCL_v4_simple_python.json')},model={**MODEL,'deployment':deployment,'region':region},binding=binding,jobs=jobs,protocol='Original pinned BFCL v4 simple_python function-calling handler and AST evaluator; first10 seed0 only',limits=dict(physical_attempts=10,input_tokens_per_attempt=1047576,output_tokens_per_attempt=2048,provider_body_bytes=32768,n=1),planned=10,fixture=False)


def evaluate_entry(entry,answer,client):
    client.benchmark_artifact={'entry':entry,'ground_truth':answer['ground_truth']}
    handler=KeelBFCLHandler(client)
    result,_=handler.inference(entry,include_input_log=False,exclude_state_log=True)
    verdict=evaluate_ast(handler,entry,result,answer['ground_truth'])
    return dict(success=verdict['valid'],reward=float(verdict['valid']),response_hash=canonical_hash(result),error_type=verdict.get('error_type'),_artifact=dict(entry=entry,response=result,ground_truth=answer['ground_truth'],verdict=verdict))


def execute(job,client):
    entry=next(e for e in entries()[:10] if e['id']==job['task_id'])
    if canonical_hash(entry)!=job['task_hash'] or job['seed']!=0:raise RuntimeError('POPULATION_DRIFT')
    answer=next(a for a in load(data_path()/'possible_answer/BFCL_v4_simple_python.json') if a['id']==entry['id'])
    return evaluate_entry(entry,answer,client)


@contextmanager
def only_keel_network():
    original=socket.socket.connect;original_ex=socket.socket.connect_ex
    def checked(sock,address):
        if not isinstance(address,tuple) or address[0] not in ('127.0.0.1','::1') or address[1]!=18081:raise RuntimeError('COMMERCIAL_EGRESS_DENIED')
        return original(sock,address)
    def checked_ex(sock,address):checked(sock,address);return 0
    socket.socket.connect=checked;socket.socket.connect_ex=checked_ex
    try:yield
    finally:socket.socket.connect=original;socket.socket.connect_ex=original_ex


def run_jobs(plan,result_path,client_factory,store,execution,*,interval_seconds=20,sleep=time.sleep):
    if not isinstance(interval_seconds,(int,float)) or not math.isfinite(interval_seconds) or not 0<=interval_seconds<=60:raise ValueError('PACING_INVALID')
    counts=dict(planned=10,completed=0,failed=0,incomplete=10,attempted_jobs=0)
    # Deliberately no resume/reclaim: interrupted batches require controller reconciliation.
    with result_path.open('x') as output:
        for job in plan['jobs']:
            if counts['attempted_jobs'] and interval_seconds:sleep(interval_seconds)
            client=client_factory();start=time.monotonic();stop=False
            row={**job,'manifest_hash':canonical_hash(plan),'model':plan['model'],'dataset_commit':BFCL_PIN,'git_sha':plan['git_sha'],'execution_git_sha':execution['git_sha'],'implementation_sha256':plan['implementation']['sha256'],'attempt':1,'run_id':client.run_id,'started_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
            if 'reservation_id' in execution:row.update(reservation_id=execution['reservation_id'],commercial_binding_hash=execution['binding_hash'])
            try:
                with only_keel_network():row.update(execute(job,client))
                row['status']='completed'
            except (AdmissionStop,ArtifactLimit) as error:
                row.update(status='incomplete',error_code=str(error));stop=True
            except Exception:
                # Local/evaluator/transport errors may lack a model response: no invented score.
                row.update(status='incomplete',error_code='INFRASTRUCTURE_OR_RESPONSE_UNKNOWN');stop=True
            row.update(latency_ms=(time.monotonic()-start)*1000,calls=client.records)
            accounting=[r.get('accounting') or {} for r in client.records]
            known=len(accounting)==client.calls and all(a.get('costStatus')=='known' for a in accounting)
            row.update(cost_known_usd=sum(a.get('costUsd',0) for a in accounting),cost_status='known' if known else 'unknown',reservation_refund_usd=0)
            private=row.pop('_artifact',getattr(client,'benchmark_artifact',{}))
            try:row['artifact']=store.write(client.run_id,dict(metadata=dict(row),exchanges=client.exchanges,benchmark=private,human_labels=None))
            except ArtifactLimit:
                row.update(status='incomplete',error_code='ARTIFACT_CAPACITY');row.pop('reward',None);row.pop('success',None);stop=True
            output.write(json.dumps(row)+'\n');output.flush();os.fsync(output.fileno())
            counts['attempted_jobs']+=1
            if row['status']=='completed':counts['completed']+=1;counts['incomplete']-=1
            if stop:break
    return counts


def private_token(path):
    path=Path(path).absolute()
    if not path.is_relative_to(ROOT/'.secrets') or path.resolve()!=path:raise RuntimeError('TOKEN_FILE_DENIED')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o600 or info.st_uid!=os.getuid() or not 0<info.st_size<=8192:raise RuntimeError('TOKEN_FILE_DENIED')
        token=os.read(fd,8193).decode().strip()
        if not token or any(c in token for c in '\r\n\0'):raise RuntimeError('TOKEN_FILE_DENIED')
        return token
    finally:os.close(fd)


def verify_commercial_manifest(plan,execution,*,region='eastus',root=None):
    verify_execution(plan,execution)
    b=plan['binding']
    if region not in ('eastus','westus') or b['region']!=region:raise RuntimeError('COMMERCIAL_REGION_BINDING_DRIFT')
    if root is None:verify_prepared_commit(plan,execution)
    else:verify_prepared_commit(plan,execution,root)
    expected=dict(manifest(execution,b['endpoint'],b['deployment'],b['quote_id'],region=region))
    if ({k:v for k,v in expected.items() if k!='git_sha'}
            != {k:v for k,v in plan.items() if k!='git_sha'}):raise RuntimeError('COMMERCIAL_MANIFEST_DRIFT')
    # Normalize only after the saved commit/tree proof and every other exact field check.
    expected['git_sha']=plan['git_sha']
    if expected!=plan:raise RuntimeError('COMMERCIAL_MANIFEST_DRIFT')


def run(plan_path,result_path,token_path,artifact_path,interval_seconds=20,*,region='eastus'):
    execution=execution_identity();plan=json.loads(plan_path.read_text())
    verify_commercial_manifest(plan,execution,region=region)
    b=plan['binding']
    token=private_token(token_path)
    def client():return KeelClient('http://127.0.0.1:18081',token,seed=0,temperature=0,max_tokens=2048,max_calls=1)
    probe=client()
    with only_keel_network():
        with probe.opener.open(Request(probe.endpoint+'/v1/agent/identity',headers={'Authorization':f'Bearer {token}'}),timeout=10) as response:identity=json.loads(response.read(4096))
    fingerprint=hashlib.sha256(json.dumps(b,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    if identity.get('bindingHash')!=fingerprint or not identity.get('reservationId'):raise RuntimeError('SERVER_BINDING_DRIFT')
    execution={**execution,'reservation_id':identity['reservationId'],'binding_hash':fingerprint}
    counts=run_jobs(plan,result_path,client,ArtifactStore(artifact_path,total_limit=20000000,job_limit=2000000),execution,interval_seconds=interval_seconds)
    print(json.dumps(dict(event='commercial_batch_finished',**counts)))


if __name__=='__main__':
    parser=argparse.ArgumentParser();subs=parser.add_subparsers(dest='command',required=True)
    prepare=subs.add_parser('prepare');prepare.add_argument('manifest',type=Path);prepare.add_argument('--binding-output',type=Path,required=True);prepare.add_argument('--endpoint',required=True);prepare.add_argument('--deployment',required=True);prepare.add_argument('--quote-id',required=True);prepare.add_argument('--region',choices=('eastus','westus'),default='eastus')
    execute_parser=subs.add_parser('run');execute_parser.add_argument('manifest',type=Path);execute_parser.add_argument('results',type=Path);execute_parser.add_argument('--token-file',type=Path,required=True);execute_parser.add_argument('--artifacts',type=Path,required=True);execute_parser.add_argument('--interval-seconds',type=float,default=20);execute_parser.add_argument('--region',choices=('eastus','westus'),default='eastus')
    args=parser.parse_args()
    try:
        if args.command=='prepare':
            value=manifest(execution_identity(),args.endpoint,args.deployment,args.quote_id,region=args.region)
            with args.manifest.open('x') as out:json.dump(value,out,indent=2)
            with args.binding_output.open('x') as out:json.dump(value['binding'],out,indent=2)
        else:run(args.manifest,args.results,args.token_file,args.artifacts,args.interval_seconds,region=args.region)
    except Exception:
        print(json.dumps(dict(event='commercial_driver_stopped',boundary='unknown_infrastructure_or_admission')),flush=True)
        raise SystemExit(1) from None

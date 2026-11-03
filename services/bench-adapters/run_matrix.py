"""Finite native batches: public metrics and bounded private synthetic evidence."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import logging
import os
from pathlib import Path
import socket
import subprocess
import time
from loguru import logger
logger.remove()
logging.disable(logging.CRITICAL)
from keel_client import KeelClient
from artifacts import ArtifactStore, ArtifactLimit
from provenance import execution_identity, verify_execution, validate_resume
from tau2_agent import KeelTauAgent, model_boundary
from bfcl_runner import KeelBFCLHandler, evaluate_ast
from local_models import MODELS, PROMPT_VARIANTS, model_key, strip_tool_descriptions
from tau2.registry import registry
from tau2.runner.helpers import select_run_tasks
from tau2.runner.presets import BenchmarkRequest, resolve_benchmark, load_cell_language
from tau2.data_model.simulation import TextRunConfig
from functools import lru_cache
from tau2.runner.simulation import run_simulation
from tau2.orchestrator.orchestrator import Orchestrator
from tau2.runner.build import build_text_orchestrator
from tau2.data_model.semantic_communication import CommunicateScoring, SemanticCommunicateSettings

ROOT=Path(__file__).resolve().parents[2]
PINS={'tau2':'cc1df47baa1544a34bb8c8e5c4ca72ad223b96a2','bfcl':'6ea57973c7a6097fd7c5915698c54c17c5b1b6c8'}
MODEL=MODELS['qwen3-8b-awq']

def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,default=str).encode()).hexdigest()
def bfcl_data():
    import bfcl_eval
    return Path(bfcl_eval.__file__).parent/'data'
def load_jsonl(path):return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

@lru_cache(maxsize=1)
def released_plan():
    return resolve_benchmark(BenchmarkRequest(preset='text', languages=['en'],
        template=TextRunConfig(num_trials=3,llm_agent='local',llm_user='local',
          llm_args_agent={'temperature':0.0},llm_args_user={'temperature':0.0},
          max_steps=100,max_errors=10,timeout=900,
          communicate_scoring=CommunicateScoring(judge=SemanticCommunicateSettings(model='local',model_args={'temperature':0.0}))),
        output=ROOT/'.tools/text-v1-english-plan'))

def released_tasks(config):
    return select_run_tasks(config,load_cell_language('en',config.domain,'text'))

# Non-live single-turn BFCL categories scored by the same original AST checker.
BFCL_CATEGORIES=('simple_python','multiple','parallel','parallel_multiple')

def prepare(path,per_domain=None,bfcl_count=None,model='qwen3-8b-awq',prompt_variant='original',bfcl_categories=('simple_python',)):
    if prompt_variant not in PROMPT_VARIANTS:raise ValueError('PROMPT_VARIANT_UNKNOWN')
    if not bfcl_categories or not set(bfcl_categories)<=set(BFCL_CATEGORIES) or len(set(bfcl_categories))!=len(bfcl_categories):raise ValueError('BFCL_CATEGORY_UNKNOWN')
    if prompt_variant!='original' and per_domain!=0:raise ValueError('PROMPT_VARIANT_BFCL_ONLY')
    chosen=MODELS[model]
    execution=execution_identity()
    jobs=[]
    for config in released_plan().configs:
        domain=config.domain
        tasks=released_tasks(config)
        if per_domain is not None:tasks=tasks[:per_domain]
        for seed in (0,1,2):
            for task in tasks:jobs.append({'benchmark':'tau2','domain':domain,'task_id':task.id,'seed':seed,'task_hash':digest(task.model_dump(mode='json'))})
    for category in bfcl_categories:
        entries=load_jsonl(bfcl_data()/f'BFCL_v4_{category}.json')
        if bfcl_count is not None:entries=entries[:bfcl_count]
        for entry in entries:jobs.append({'benchmark':'bfcl','category':category,'task_id':entry['id'],'seed':0,'task_hash':digest(entry)})
    for i,job in enumerate(jobs):job['job_id']=i
    manifest={'schema':3,'implementation':execution['implementation'],'released_plan':released_plan().model_dump(mode='json'),'git_sha':execution['git_sha'],'dataset_commits':PINS,'model':chosen,'simulator':chosen,'judge':chosen,'prompt_variant':prompt_variant,'protocol':'tau2 half-duplex text, original ALL evaluation and semantic communicate; BFCL v4 simple_python original AST','subset':{'per_domain':per_domain,'bfcl_count':bfcl_count},'seeds':[0,1,2],'seed_usage':'orchestrator agent/user RNG and Keel provider request seed; temperature 0 may make repeats identical','jobs':jobs,'commercial':{'openai':'unrun: no dispatch-bound paid admission configured','anthropic':'unrun: no dispatch-bound paid admission configured'},'limits':{'max_steps':100,'max_errors':10,'per_task_seconds':900,'max_requests':1000,'max_gpu_seconds':14400}}
    if tuple(bfcl_categories)!=('simple_python',):manifest['bfcl_categories']=list(bfcl_categories)
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('x') as out:json.dump(manifest,out,indent=2)
    print(json.dumps({'event':'manifest_created','jobs':len(jobs),'manifest_hash':digest(manifest)}))

@contextmanager
def only_keel_network():
    """Fail closed against accidental upstream SDK/provider/vLLM bypass in this process."""
    original=socket.socket.connect;original_ex=socket.socket.connect_ex
    def checked(sock,address):
        if not isinstance(address,tuple) or address[0] not in ('127.0.0.1','::1') or address[1]!=18080:raise RuntimeError('BENCHMARK_EGRESS_DENIED')
        return original(sock,address)
    def checked_ex(sock,address):checked(sock,address);return 0
    socket.socket.connect=checked;socket.socket.connect_ex=checked_ex
    try:yield
    finally:socket.socket.connect=original;socket.socket.connect_ex=original_ex

def run_tau(job,client):
    config=next(c for c in released_plan().configs if c.domain==job['domain'])
    task=next(t for t in released_tasks(config) if t.id==job['task_id'])
    if digest(task.model_dump(mode='json'))!=job['task_hash']:raise RuntimeError('TASK_DRIFT')
    client.benchmark_artifact={'task':task.model_dump(mode='json'),'config':config.model_dump(mode='json')}
    orch=build_text_orchestrator(config,task,seed=job['seed'])
    with model_boundary(client):result=run_simulation(orch)
    return {'success':result.reward_info.reward==1.0,'reward':result.reward_info.reward,'termination':result.termination_reason.value,'trajectory_hash':digest([m.model_dump(mode='json') for m in result.messages]),'policy_hash':hashlib.sha256(orch.environment.get_policy().encode()).hexdigest(),
       '_artifact':{'task':task.model_dump(mode='json'),'simulation':result.model_dump(mode='json'),'config':config.model_dump(mode='json')}}

def run_bfcl(job,client,prompt_variant='original'):
    if prompt_variant not in PROMPT_VARIANTS:raise ValueError('PROMPT_VARIANT_UNKNOWN')
    category=job.get('category','simple_python')
    if category not in BFCL_CATEGORIES:raise RuntimeError('TASK_DRIFT')
    entry=next(e for e in load_jsonl(bfcl_data()/f'BFCL_v4_{category}.json') if e['id']==job['task_id'])
    if digest(entry)!=job['task_hash']:raise RuntimeError('TASK_DRIFT')
    answer=next(e for e in load_jsonl(bfcl_data()/f'possible_answer/BFCL_v4_{category}.json') if e['id']==entry['id'])
    client.benchmark_artifact={'entry':entry,'ground_truth':answer['ground_truth']}
    handler=KeelBFCLHandler(client)
    # The variant changes only what the model sees; scoring always uses the original entry.
    sent=entry if prompt_variant=='original' else {**entry,'function':strip_tool_descriptions(entry['function'])}
    result,_=handler.inference(sent,include_input_log=False,exclude_state_log=True)
    verdict=evaluate_ast(handler,entry,result,answer['ground_truth'])
    return {'success':verdict['valid'],'reward':float(verdict['valid']),'response_hash':digest(result),'error_type':verdict.get('error_type'),'_artifact':{'entry':entry,'response':result,'ground_truth':answer['ground_truth'],'verdict':verdict}}

def run(manifest_path,result_path,max_jobs,artifacts=None):
    manifest=json.loads(manifest_path.read_text())
    execution=execution_identity()
    verify_execution(manifest,execution)
    rows=load_jsonl(result_path) if result_path.exists() else []
    done,attempts=validate_resume(manifest,rows)
    try:model_key(manifest['model'])
    except ValueError:raise RuntimeError('MANIFEST_DRIFT') from None
    if manifest['dataset_commits']!=PINS:raise RuntimeError('MANIFEST_DRIFT')
    variant=manifest.get('prompt_variant','original')
    if digest(manifest['released_plan'])!=digest(released_plan().model_dump(mode='json')):raise RuntimeError('RELEASED_PLAN_DRIFT')
    token=(ROOT/'.secrets/benchmark-token').read_text().strip()
    # A long run gets its own directory (and its own store limit) instead of a larger shared limit.
    store=ArtifactStore(artifacts or ROOT/'.tools/benchmark-artifacts')
    count=0
    finished=0
    dispatched=0
    with result_path.open('a') as output:
        for job in manifest['jobs']:
            if job['job_id'] in done:
                continue
            if count>=max_jobs or dispatched>=1000:
                break
            count+=1
            start=time.monotonic()
            client=KeelClient('http://127.0.0.1:18080',token,seed=job['seed'],max_calls=1000-dispatched)
            record={
                **job,
                'manifest_hash':digest(manifest),
                'model':manifest['model'],
                'dataset_commit':PINS[job['benchmark']],
                'git_sha':manifest['git_sha'],
                'execution_git_sha':execution['git_sha'],
                'implementation_sha256':execution['implementation']['sha256'],
                'attempt':attempts.get(job['job_id'],0)+1,
                'run_id':client.run_id,
                'started_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
            }
            stop=False
            try:
                with only_keel_network():
                    record.update(run_tau(job,client) if job['benchmark']=='tau2' else run_bfcl(job,client,variant))
                record['status']='completed'
            except ArtifactLimit as error:
                record.update(status='incomplete',success=False,error_code=str(error))
                stop=True
            except Exception as error:
                record.update(status='failed' if client.calls else 'invalid',success=False,error_code=type(error).__name__)
            dispatched+=client.calls
            record.update(latency_ms=(time.monotonic()-start)*1000,calls=client.records)
            accounting=[r.get('accounting') or {} for r in client.records]
            known=all(a.get('costStatus')=='known' for a in accounting) and len(accounting)==client.calls
            record.update(cost_known_usd=sum(a.get('costUsd',0) for a in accounting),cost_status='known' if known else 'unknown',api_pricing_usd=0,local_gpu_dollars=None)
            private=record.pop('_artifact',getattr(client,'benchmark_artifact',{}))
            try:
                record['artifact']=store.write(client.run_id,{'metadata':dict(record),'exchanges':client.exchanges,'benchmark':private,'human_labels':None})
            except ArtifactLimit as error:
                record.update(status='incomplete',success=False,error_code=str(error))
                record.pop('reward',None)
                stop=True
            output.write(json.dumps(record)+'\n')
            output.flush()
            os.fsync(output.fileno())
            print(json.dumps({'event':'job_finished','job_id':job['job_id'],'status':record['status'],'reward':record.get('reward'),'calls':client.calls,'latency_ms':round(record['latency_ms'])}),flush=True)
            if record['status'] in ('completed','failed'):
                finished+=1
            if stop:
                break
    print(json.dumps({'event':'batch_finished','new_jobs':count,'remaining':len(manifest['jobs'])-len(done)-finished}),flush=True)

def parser():
    parser=argparse.ArgumentParser();sub=parser.add_subparsers(dest='command',required=True)
    prep=sub.add_parser('prepare');prep.add_argument('manifest',type=Path);prep.add_argument('--per-domain',type=int);prep.add_argument('--bfcl-count',type=int)
    prep.add_argument('--model',choices=sorted(MODELS),default='qwen3-8b-awq');prep.add_argument('--prompt-variant',choices=PROMPT_VARIANTS,default='original')
    prep.add_argument('--bfcl-categories',default='simple_python',help='comma-separated: '+','.join(BFCL_CATEGORIES))
    execute=sub.add_parser('run');execute.add_argument('manifest',type=Path);execute.add_argument('results',type=Path);execute.add_argument('--max-jobs',type=int,default=10)
    execute.add_argument('--artifacts',type=Path)
    return parser

if __name__=='__main__':
    args=parser().parse_args()
    if args.command=='prepare':prepare(args.manifest,args.per_domain,args.bfcl_count,args.model,args.prompt_variant,tuple(args.bfcl_categories.split(',')))
    else:run(args.manifest,args.results,args.max_jobs,args.artifacts)

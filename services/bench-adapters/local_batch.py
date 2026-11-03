"""Run only via scripts/with_gpu.sh. Fixed local routes, bounded lifetime and owned children."""
import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import threading
import time
from urllib.request import urlopen
import psutil
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
from resources import BATCH_MEMORY_LIMIT, admit_resources
from local_models import MODELS, POOLING_MODELS, judge_max_tokens, model_key, pooling_command, vllm_command

def judge_command(root,samples,output,rubric=None,versions=None,concurrency=None,max_tokens=None):
    """Judge run against the already-started local backend. Default: Task 9 rubric, prompt versions v1 and v2, serial."""
    command=[str(root/'node_modules/.bin/tsx'),str(root/'packages/evals/src/judgeRun.ts'),'run',str(samples.resolve()),str(output.resolve())]
    if rubric:command+=['--rubric',rubric]
    if versions:command+=['--versions',versions]
    if concurrency:command+=['--concurrency',str(concurrency)]
    if max_tokens:command+=['--max-tokens',str(max_tokens)]
    return command

def matrix_command(python,root,manifest,results,max_jobs,artifacts=None):
    """Task 8/10 matrix batch. `artifacts` gives the run its own private artifact store."""
    command=[python,str(root/'services/bench-adapters/run_matrix.py'),'run',manifest,results,'--max-jobs',str(max_jobs)]
    if artifacts:command+=['--artifacts',str(artifacts.resolve())]
    return command

def rag_answer_command(root,prepared,output):
    """Task 14 faithfulness: before/after-rerank answers against the already-started local backend."""
    return [str(root/'node_modules/.bin/tsx'),str(root/'packages/rag/src/faithfulnessRun.ts'),'answer',str(prepared.resolve()),str(output.resolve())]

def langfuse_command(root,spec,output):
    """Task 4: real runAgent runs traced OTLP -> collector -> local Langfuse, against the already-started backend."""
    return [str(root/'node_modules/.bin/tsx'),str(root/'packages/runtime/src/langfuseRun.ts'),'run',str(spec.resolve()),str(output.resolve())]

def security_command(python,root,manifest,output,model_id):
    """Task 13 matrix run against the already-started local backend."""
    # Absolute: the TS controlled runner resolves journal paths from packages/runtime.
    return [python,str(root/'services/bench-adapters/security_matrix.py'),'run','--input',str(manifest.resolve()),'--output',str(output.resolve()),'--model-id',model_id]

def security_full_command(python,root,manifest,output,workers,deadline_seconds):
    """Phase 6 full AgentDojo matrix: concurrent episodes, resumable output directory."""
    return [python,str(root/'services/bench-adapters/security_matrix.py'),'run-full','--input',str(manifest.resolve()),'--output',str(output.resolve()),
            '--workers',str(workers),'--deadline-seconds',str(deadline_seconds)]

# Phase 6 retrieval stages: which local model each stage serves (see packages/rag/src/beirRun.ts).
RAG_BEIR_STAGES = {'embed': 'bge-base-en-v1.5', 'rerank-ce': 'bge-reranker-base', 'rerank-llm': 'qwen3-8b-awq'}

def rag_beir_command(root,stage,spec,output):
    return [str(root/'node_modules/.bin/tsx'),str(root/'packages/rag/src/beirRun.ts'),stage,str(spec.resolve()),str(output.resolve())]

def main():
    parser=argparse.ArgumentParser();parser.add_argument('manifest');parser.add_argument('results');parser.add_argument('--max-jobs',type=int,default=12);parser.add_argument('--seconds',type=int,default=7200)
    # --security MODEL: manifest is a security_matrix manifest (.json.gz), results an output directory.
    parser.add_argument('--security',choices=sorted(MODELS))
    # --security-full MODEL: manifest is a prepare-full manifest (.json.gz), results a (resumable) output directory.
    # --workers N concurrent episodes; vLLM --max-num-seqs and the backend's in-flight bound follow it.
    # --rag-beir STAGE: manifest is the retrieval spec .json, results the output directory.
    parser.add_argument('--rag-beir',choices=sorted(RAG_BEIR_STAGES))
    parser.add_argument('--security-full',choices=sorted(MODELS));parser.add_argument('--workers',type=int,default=1)
    # --judge MODEL: manifest is a samples .jsonl, results an output directory.
    parser.add_argument('--judge',choices=sorted(MODELS))
    # With --judge: a named rubric and comma-separated prompt versions instead of the Task 9 defaults.
    parser.add_argument('--judge-rubric');parser.add_argument('--judge-versions')
    # --rag-answer MODEL: manifest is a faithfulnessRun prepared .jsonl, results an output directory.
    parser.add_argument('--rag-answer',choices=sorted(MODELS))
    # --langfuse MODEL: manifest is a langfuseRun spec .json, results an output directory.
    parser.add_argument('--langfuse',choices=sorted(MODELS))
    # Tighter batch memory reservation when other Keel services (the Langfuse stack) are running.
    parser.add_argument('--memory-limit',type=int,default=BATCH_MEMORY_LIMIT)
    parser.add_argument('--artifacts',type=Path);args=parser.parse_args()
    if not 0<args.seconds<=14000 or not 0<args.max_jobs<=1000 or not 1<=args.workers<=16:raise ValueError('INVALID_BATCH_LIMIT')
    if os.environ.get('HF_HOME')!='/home/postedism/.cache/huggingface' or os.environ.get('OPENAI_BASE_URL')!='http://127.0.0.1:18000/v1':raise RuntimeError('GPU_WRAPPER_REQUIRED')
    # GPU wrapper owns the surrounding process group and the real shared flock.
    folder=ROOT/'.secrets';folder.mkdir(exist_ok=True,mode=0o700)
    for name in ['benchmark-token','vllm-token']:
        path=folder/name
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as out:out.write(secrets.token_hex(32))
    env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1','HF_HUB_OFFLINE':'1','HF_HUB_DISABLE_TELEMETRY':'1','VLLM_NO_USAGE_STATS':'1','DO_NOT_TRACK':'1','TMPDIR':str(ROOT/'.tools/vllm-tmp'),'VLLM_CACHE_ROOT':str(ROOT/'.tools/vllm-jit'),'TRITON_CACHE_DIR':str(ROOT/'.tools/vllm-jit/triton'),'TORCHINDUCTOR_CACHE_DIR':str(ROOT/'.tools/vllm-jit/inductor'),'CUDA_CACHE_PATH':str(ROOT/'.tools/vllm-jit/cuda'),'XDG_CACHE_HOME':str(ROOT/'.tools/vllm-jit/xdg'),'NUMBA_CACHE_DIR':str(ROOT/'.tools/vllm-jit/numba'),'LD_LIBRARY_PATH':str(ROOT/'.tools/vllm-venv/lib/python3.12/site-packages/nvidia/cudnn/lib')+':'+str(ROOT/'.tools/vllm-venv/lib/python3.12/site-packages/nvidia/nccl/lib')+':/usr/local/cuda/lib64','KEEL_TOKEN_FILE':str(folder/'benchmark-token'),'KEEL_VLLM_TOKEN_FILE':str(folder/'vllm-token'),'KEEL_SPAN_FILE':str(ROOT/'.tools'/f'spans-{time.time_ns()}.jsonl'),'KEEL_MAX_REQUESTS':'200000' if args.security_full else '5000' if args.judge else '1000','KEEL_MAX_CONCURRENT':str(args.workers)}
    # Serve exactly the registered model the manifest was prepared for.
    served=args.security or args.security_full or args.judge or args.rag_answer or args.langfuse or (args.rag_beir and RAG_BEIR_STAGES[args.rag_beir])
    if served in POOLING_MODELS:
        command=pooling_command(str(ROOT/'.tools/vllm-venv/bin/python'),ROOT,served,(folder/'vllm-token').read_text())
    else:
        model=MODELS[served] if served else json.loads(Path(args.manifest).read_text())['model'];model_key(model)
        command=vllm_command(str(ROOT/'.tools/vllm-venv/bin/python'),model,(folder/'vllm-token').read_text(),max_num_seqs=args.workers)
    children=[];start=time.monotonic();ready=threading.Event();peak_rss=0;peak_disk=0;last_resources=None
    def stop(_signum,_frame):raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,stop)
    def drain(pipe):
        # No inference-time vLLM output is retained. Before readiness there are no prompts.
        with (ROOT/'.tools/vllm-startup.log').open('w') as output:
            count=0
            for line in iter(pipe.readline,b''):
                if not ready.is_set() and count<1000000:
                    text=line.decode(errors='replace').replace((folder/'vllm-token').read_text(),'[redacted]');output.write(text);output.flush();count+=len(line)
    def check():
        nonlocal peak_rss,peak_disk,last_resources
        snapshot=admit_resources(args.memory_limit)
        last_resources=snapshot
        rss=snapshot['memory']['batch_rss_bytes']
        disk=snapshot['disk']['total_bytes']
        peak_rss=max(peak_rss,rss)
        peak_disk=max(peak_disk,disk)
        if time.monotonic()-start>args.seconds:
            raise RuntimeError('BATCH_TIME_LIMIT')

    try:
        check()
        server=subprocess.Popen(command,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT);children.append(server)
        threading.Thread(target=drain,args=(server.stdout,),daemon=True).start()
        while not ready.is_set():
            if server.poll() is not None:raise RuntimeError('VLLM_START_FAILED')
            try:
                with urlopen('http://127.0.0.1:18000/health',timeout=1) as response:
                    if response.status==200:ready.set()
            except OSError:pass
            check();time.sleep(1)
        print(json.dumps({'event':'vllm_ready','elapsed_seconds':round(time.monotonic()-start),'project_and_images_bytes':peak_disk,'rss_bytes':peak_rss}),flush=True)
        api=subprocess.Popen([str(ROOT/'node_modules/.bin/tsx'),str(ROOT/'services/api/src/server.ts')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,cwd=ROOT);children.append(api)
        time.sleep(2)
        bench_env={**env,'PYTHONPATH':str(ROOT/'.tools/bench-upstream/gorilla-6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard')}
        if args.judge:
            # --workers N verdicts in flight; thinking judges get the larger token budget.
            command=judge_command(ROOT,Path(args.manifest),Path(args.results),args.judge_rubric,args.judge_versions,
                                  args.workers if args.workers>1 else None,judge_max_tokens(MODELS[args.judge]) if MODELS[args.judge]['thinking'] else None)
        elif args.rag_answer:
            command=rag_answer_command(ROOT,Path(args.manifest),Path(args.results))
        elif args.langfuse:
            command=langfuse_command(ROOT,Path(args.manifest),Path(args.results))
        elif args.rag_beir:
            command=rag_beir_command(ROOT,args.rag_beir,Path(args.manifest),Path(args.results))
        elif args.security_full:
            # Stop starting new episodes 10 minutes before the batch limit; in-flight ones finish.
            command=security_full_command(str(ROOT/'.tools/bench-venv/bin/python'),ROOT,Path(args.manifest),Path(args.results),args.workers,max(60,args.seconds-600-round(time.monotonic()-start)))
            bench_env['KEEL_SECURITY_TOKEN']=(folder/'benchmark-token').read_text()
        elif args.security:
            from security_plan import model_entry
            command=security_command(str(ROOT/'.tools/bench-venv/bin/python'),ROOT,Path(args.manifest),Path(args.results),model_entry(args.security)['id'])
            bench_env['KEEL_SECURITY_TOKEN']=(folder/'benchmark-token').read_text()
        else:
            command=matrix_command(str(ROOT/'.tools/bench-venv/bin/python'),ROOT,args.manifest,args.results,args.max_jobs,args.artifacts)
        runner=subprocess.Popen(command,env=bench_env,cwd=ROOT);children.append(runner)
        while runner.poll() is None:
            check()
            if server.poll() is not None or api.poll() is not None:raise RuntimeError('SERVICE_STOPPED')
            time.sleep(1)
        if runner.returncode:raise RuntimeError('BENCHMARK_PROCESS_FAILED')
    finally:
        ready.set()
        # Workers remain in wrapper-owned process group; terminate descendants explicitly too.
        descendants=psutil.Process(os.getpid()).children(recursive=True)
        for child in reversed(children):
            if child.poll() is None:child.terminate()
        for child in children:
            try:child.wait(timeout=10)
            except subprocess.TimeoutExpired:child.kill();child.wait()
        for child in descendants:
            try:
                if child.is_running():child.kill()
            except psutil.NoSuchProcess:pass
        report={'event':'batch_cleanup','peak_rss_bytes':peak_rss,'peak_scoped_disk_bytes':peak_disk,'last_resource_snapshot':last_resources,'seconds':round(time.monotonic()-start),'owned_processes_stopped':all(c.poll() is not None for c in children),'span_file':env['KEEL_SPAN_FILE']}
        (ROOT/'.tools/batch-lifecycle.json').write_text(json.dumps(report,indent=2));print(json.dumps(report),flush=True)
if __name__=='__main__':main()

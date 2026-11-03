"""Task12 controller-admitted single-container CPU fixture runner.
Re-running requires a current resource admission. No images pulled or services reused.
"""
import os, subprocess, time, sys
from pathlib import Path
os.chdir(Path(__file__).resolve().parents[3])
expected_image = 'sha256:3e8b3adfd27b5707128f60956f62a793c3c9326ea8cfaf0eab7adccb5d700b21'
actual_image = subprocess.check_output(['docker', 'image', 'inspect', 'pgvector/pgvector:0.8.1-pg17', '--format', '{{.Id}}'], text=True).strip()
if actual_image != expected_image:
    raise RuntimeError('EXISTING_IMAGE_MISMATCH')
cid = None
result = None
try:
    cid = subprocess.check_output(['docker','run','--detach','--pull=never','--name','keel-task12-pg','--label','project=keel','--label','purpose=task12-guard-tests','--memory','512m','--cpus','1','--tmpfs','/var/lib/postgresql/data:rw,size=128m','--shm-size','32m','--log-opt','max-size=1m','--log-opt','max-file=1','-e','POSTGRES_PASSWORD=fixture-only','-p','127.0.0.1::5432','pgvector/pgvector:0.8.1-pg17'],text=True).strip()
    print('OWNED_CONTAINER='+cid,flush=True)
    for _ in range(50):
        if subprocess.run(['docker','exec',cid,'pg_isready','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0: break
        time.sleep(.2)
    else: raise RuntimeError('PG_NOT_READY')
    port=subprocess.check_output(['docker','port',cid,'5432/tcp'],text=True).strip().split(':')[-1]
    env={**os.environ,'KEEL_TEST_POSTGRES_URL':f'postgresql://postgres:fixture-only@127.0.0.1:{port}/postgres','TESTCONTAINERS_RYUK_DISABLED':'true'}
    command=['node','.tools/pnpm/node_modules/pnpm/bin/pnpm.cjs','--filter','guard','--filter','runtime','--filter','mcp-common','-r','--workspace-concurrency=1','exec','vitest','run','--no-file-parallelism','--maxWorkers=1']
    with open('/tmp/keel-task12-full-ts.log','w') as log:
        result=subprocess.run(command,env=env,stdout=log,stderr=subprocess.STDOUT)
    print('TEST_EXIT='+str(result.returncode),flush=True)
    print(open('/tmp/keel-task12-full-ts.log').read(),flush=True)
finally:
    if cid:
        print('OWNED_SIZE='+subprocess.check_output(['docker','inspect','--size','--format','{{.SizeRw}}',cid],text=True).strip(),flush=True)
        subprocess.run(['docker','rm','-fv',cid],check=True)
        print('OWNED_CLEANUP=removed',flush=True)

sys.exit(result.returncode if result else 1)

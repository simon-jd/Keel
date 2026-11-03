"""Bind every attempt to a fixed population and the implementation actually on disk."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[2]
PRODUCTION_ROOTS=('packages','services','scripts','infra','package.json','pnpm-lock.yaml',
                  'pnpm-workspace.yaml','tsconfig.base.json')


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,default=str).encode()).hexdigest()


def production_file(name):
    path=Path(name)
    return (not {'test','tests','__pycache__'}.intersection(path.parts)
            and (path.suffix in {'.ts','.tsx','.js','.mjs','.py','.json','.yaml','.yml','.toml','.sh','.lock'}
                 or path.name=='Dockerfile'))


def git(root,*args):
    return subprocess.check_output(['git',*args],cwd=root,text=True).strip()


def execution_identity(root=ROOT):
    """Documentation-only commits may differ; dirty production and new code fail closed."""
    root=Path(root)
    head=git(root,'rev-parse','HEAD')
    names=git(root,'ls-tree','-r','--name-only',head,'--',*PRODUCTION_ROOTS).splitlines()
    names=sorted(name for name in names if production_file(name))
    changed=git(root,'diff','--name-only',head,'--',*PRODUCTION_ROOTS).splitlines()
    untracked=git(root,'ls-files','--others','--exclude-standard','--',*PRODUCTION_ROOTS).splitlines()
    if any(production_file(name) for name in changed+untracked):
        raise ValueError('DIRTY_PRODUCTION_IMPLEMENTATION')
    if not names:
        raise ValueError('EMPTY_IMPLEMENTATION_IDENTITY')
    # Actual imported upstream source is ignored by Git but must also remain fixed.
    source_roots=(root/'.tools/bench-upstream').glob('*/src/tau2')
    upstream=list(source_roots)+list((root/'.tools/bench-upstream').glob('*/berkeley-function-call-leaderboard/bfcl_eval'))
    names+=sorted(str(path.relative_to(root)) for folder in upstream for path in folder.rglob('*.py'))
    files=[]
    for name in names:
        path=root/name
        if path.is_symlink() or not path.is_file():
            raise ValueError('IMPLEMENTATION_FILE_UNAVAILABLE')
        files.append({'path':name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    if git(root,'rev-parse','HEAD')!=head:
        raise ValueError('IMPLEMENTATION_CHANGED_DURING_SNAPSHOT')
    return {'git_sha':head,'implementation':{'sha256':canonical_hash(files),'files':files}}


def verify_execution(manifest,execution):
    if manifest.get('schema')!=3:
        raise ValueError('MANIFEST_SCHEMA_UNSUPPORTED')
    if manifest.get('implementation')!=execution['implementation']:
        raise ValueError('EXECUTION_IDENTITY_DRIFT')


def verify_prepared_commit(manifest,execution,root=ROOT):
    """Prove an ancestor preparation commit has exactly the current production tree."""
    import re
    saved=manifest.get('git_sha');current=execution.get('git_sha')
    if any(not isinstance(value,str) or not re.fullmatch('[0-9a-f]{40}',value) for value in (saved,current)):
        raise ValueError('PREPARED_COMMIT_IDENTITY_INVALID')
    def checked(*args):
        return subprocess.run(['git',*args],cwd=root,text=True,stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL,check=True).stdout
    try:
        if checked('rev-parse','--verify',saved+'^{commit}').strip()!=saved:
            raise ValueError('PREPARED_COMMIT_IDENTITY_INVALID')
        checked('merge-base','--is-ancestor',saved,current)
        # Keep deleted production paths visible even when their destination is excluded.
        changed=checked('diff','--no-renames','--name-only','-z',saved,current,'--',*PRODUCTION_ROOTS).split('\0')
        if any(production_file(name) for name in changed if name):
            raise ValueError('PREPARED_COMMIT_PRODUCTION_DRIFT')
        if execution_identity(root)!=execution:
            raise ValueError('EXECUTION_IDENTITY_DRIFT')
    except (OSError,subprocess.CalledProcessError) as error:
        raise ValueError('PREPARED_COMMIT_IDENTITY_INVALID') from error


def validate_resume(manifest,rows):
    """Only incomplete/invalid attempts may repeat, with distinct runs and increasing attempts.

    Terminal rows are never rerun. All prior rows remain in the stream for incurred-cost
    accounting; score aggregation uses only the latest attempt per manifest job.
    """
    jobs={}
    for job in manifest['jobs']:
        number=job.get('job_id')
        if type(number)!=int or number<0 or number in jobs:
            raise ValueError('MANIFEST_JOB_IDENTITY_INVALID')
        jobs[number]=job
    manifest_hash=canonical_hash(manifest)
    done=set()
    attempts={}
    runs=set()
    for row in rows:
        number=row.get('job_id')
        job=jobs.get(number)
        if type(number)!=int or job is None or number in done or any(row.get(key)!=value for key,value in job.items()):
            raise ValueError('RESULT_JOB_IDENTITY_DRIFT')
        expected={'manifest_hash':manifest_hash,'implementation_sha256':manifest['implementation']['sha256'],
                  'model':manifest['model'],'git_sha':manifest['git_sha'],
                  'dataset_commit':manifest['dataset_commits'][job['benchmark']]}
        if any(row.get(key)!=value for key,value in expected.items()):
            raise ValueError('RESULT_MANIFEST_DRIFT')
        if not isinstance(row.get('execution_git_sha'),str) or not row['execution_git_sha']:
            raise ValueError('RESULT_EXECUTION_IDENTITY_MISSING')
        run_id=row.get('run_id')
        attempt=attempts.get(number,0)+1
        if not isinstance(run_id,str) or not run_id or run_id in runs or type(row.get('attempt'))!=int or row['attempt']!=attempt:
            raise ValueError('RESULT_ATTEMPT_INVALID')
        status=row.get('status')
        if status not in {'completed','failed','invalid','incomplete'}:
            raise ValueError('RESULT_STATUS_INVALID')
        runs.add(run_id)
        attempts[number]=attempt
        if status in {'completed','failed'}:
            done.add(number)
    return done,attempts

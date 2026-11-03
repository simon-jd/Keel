"""Current scoped admission shared by benchmark lifecycle and private evidence writes."""
import os
from pathlib import Path
import sys
import psutil
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
import resource_check

# Batch/artifact stop, 50 MB under the 16 GB project share.
DISK_STOP=15_950_000_000
# Recorded vLLM batch peaks are 4.8-6.3 GB. 12 GB leaves room for agent tooling that runs
# inside the repository while keeping batch + other Keel processes under the 16 GB share.
BATCH_MEMORY_LIMIT=12_000_000_000
TOTAL_MEMORY_LIMIT=16_000_000_000


def disk_snapshot():
    return resource_check.disk_report(ROOT,resource_check.PROJECT_BYTES)


def disk_usage():
    return disk_snapshot()['total_bytes']


def memory_snapshot():
    parent=psutil.Process(os.getpid())
    batch=[parent,*parent.children(recursive=True)]
    batch_ids={process.pid for process in batch}
    batch_rss=0
    for process in batch:
        try:batch_rss+=process.memory_info().rss
        except psutil.NoSuchProcess:pass
    # Reserve full hard limits of running project containers, not a stale RSS sample.
    ids=resource_check.owned_ids('ps','--all')
    container_reserved=0
    if ids:
        details=resource_check.docker('container','inspect',*ids,as_json=True)
        if len(details)!=len(ids):raise ValueError('INCOMPLETE_MEMORY_INVENTORY')
        for item in details:
            if not resource_check.project_owned(item.get('Config',{}).get('Labels')):
                raise ValueError('UNKNOWN_MEMORY_OWNERSHIP')
            running=item.get('State',{}).get('Running')
            if type(running)!=bool:
                raise ValueError('UNKNOWN_CONTAINER_RUNNING_STATE')
            if running:
                limit=resource_check.nonnegative(item.get('HostConfig',{}).get('Memory'))
                if not limit:raise ValueError('UNBOUNDED_PROJECT_CONTAINER_MEMORY')
                container_reserved+=limit
    native_rss=0
    auxiliary_rss=0
    processes=[]
    ancestor_ids={process.pid for process in parent.parents()}
    for process in psutil.process_iter(['pid','name','status','uids','cwd','exe','memory_info']):
        if process.pid in batch_ids:continue
        try:
            info=process.info
            if info['status']==psutil.STATUS_ZOMBIE:
                continue
            owned=any(Path(info[key]).is_relative_to(ROOT) for key in ('cwd','exe') if info[key])
            # A Keel scope can establish ownership even with readable cwd/exe
            # outside the repository, such as a service running /usr/bin/node.
            if not owned:
                try:
                    groups=(Path('/proc')/str(process.pid)/'cgroup').read_text()
                    owned=any(part.startswith('keel-') or part.startswith('keel.')
                              for line in groups.splitlines() for part in line.split('/'))
                except (FileNotFoundError,PermissionError):
                    continue
            if not owned:
                continue
            if info['uids'] is None or info['memory_info'] is None:
                raise ValueError('UNKNOWN_PROJECT_PROCESS_MEMORY')
            if info['cwd'] is None or info['exe'] is None:
                raise ValueError('UNKNOWN_OWNED_PROCESS_PATH')
            rss=info['memory_info'].rss
            auxiliary=process.pid in ancestor_ids or info['name'] in {'git','codex','codex-linux-sandbox'}
            if auxiliary:
                auxiliary_rss+=rss
            else:
                native_rss+=rss
            processes.append({'pid':process.pid,'name':info['name'],
                              'classification':'inspection_auxiliary' if auxiliary else 'native_project_process',
                              'rss_bytes':rss})
        except psutil.NoSuchProcess:continue
    return {'batch_rss_bytes':batch_rss,'other_native_rss_bytes':native_rss,
            'other_container_reserved_bytes':container_reserved,
            'auxiliary_rss_bytes':auxiliary_rss,'processes':processes,
            'other_reserved_bytes':native_rss+container_reserved+auxiliary_rss}


def admit_resources(batch_limit=BATCH_MEMORY_LIMIT):
    # A batch next to running Keel services (e.g. the Langfuse stack) may reserve less, never more.
    if type(batch_limit)!=int or not 0<batch_limit<=BATCH_MEMORY_LIMIT:
        raise ValueError('INVALID_BATCH_MEMORY_LIMIT')
    disk=disk_snapshot()
    memory=memory_snapshot()
    # The batch is capped at batch_limit (checked every second). Leave at least its full
    # reservation plus currently resident/reserved other Keel services under 16 GB.
    if disk['total_bytes']>DISK_STOP:
        raise ValueError('BATCH_DISK_LIMIT')
    if (memory['batch_rss_bytes']>batch_limit or
            memory['other_reserved_bytes']+batch_limit>TOTAL_MEMORY_LIMIT):
        raise ValueError('BATCH_TOTAL_SERVICE_MEMORY_LIMIT')
    return {'disk':disk,'memory':memory}

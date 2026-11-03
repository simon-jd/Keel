"""Rebuild the audited local runtime serially. System CUDA substitutions require separate ABI proof."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import unquote,urlsplit
from urllib.request import urlopen
import zipfile
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
from resource_check import disk_report

def admitted_peak(current,compressed,members,reserve=200000000):
    if any(type(v)!=int or v<0 for v in [current,compressed,reserve,*members]):raise ValueError('INVALID_RESOURCE_ESTIMATE')
    peak=current+compressed+2*sum((size+4095)//4096*4096 for size in members)+reserve
    if peak>8000000000:raise ValueError('INSTALL_ADMISSION_DENIED')
    return peak

def main():
    lock=json.loads((Path(__file__).with_name('vllm-runtime.lock.json')).read_text())
    temporary=ROOT/'.tools/vllm-install';temporary.mkdir(parents=True,exist_ok=True)
    cache=ROOT/'.tools/vllm-cache';cache.mkdir(exist_ok=True)
    env={**os.environ,'UV_CACHE_DIR':str(cache),'TMPDIR':str(temporary),'PYTHONDONTWRITEBYTECODE':'1'}
    python=ROOT/'.tools/vllm-venv/bin/python'
    if not python.exists():subprocess.run(['/home/postedism/.local/bin/uv','venv','--python','/home/postedism/.local/bin/python3.12',str(python.parent.parent)],check=True,env=env)
    for row in sorted(lock['install'],key=lambda r:r['compressed_bytes'],reverse=True):
        used=disk_report(ROOT,8000000000)['total_bytes']
        # Admit download first; exact 4KiB-rounded unpack peak is checked before installation.
        admitted_peak(used,row['compressed_bytes'],[])
        file=temporary/unquote(urlsplit(row['url']).path.split('/')[-1])
        with urlopen(row['url'],timeout=120) as response,file.open('xb') as output:
            h=hashlib.sha256();size=0
            while chunk:=response.read(1048576):
                size+=len(chunk)
                if size>row['compressed_bytes']:raise ValueError('WHEEL_SIZE_MISMATCH')
                h.update(chunk);output.write(chunk)
        if size!=row['compressed_bytes'] or h.hexdigest()!=row['sha256']:raise ValueError('WHEEL_HASH_MISMATCH')
        with zipfile.ZipFile(file) as archive:members=[i.file_size for i in archive.infolist()]
        admitted_peak(used,row['compressed_bytes'],members)
        subprocess.run(['/home/postedism/.local/bin/uv','pip','install','--python',str(python),'--no-deps','--no-cache',str(file)],check=True,env=env)
        file.unlink()
        if disk_report(ROOT,8000000000)['total_bytes']>7800000000:raise ValueError('WARMUP_RESERVE_DENIED')
        print(json.dumps({'installed':row['name'],'version':row['version']}),flush=True)
    # pip-check's expected native-package metadata gaps are reported, never disguised as passing.
    subprocess.run(['/home/postedism/.local/bin/uv','pip','check','--python',str(python)],env=env,check=False)
if __name__=='__main__':main()

"""Private synthetic benchmark evidence, separate from logs, metrics and traces."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
from resources import DISK_STOP, disk_usage as current_disk_usage

class ArtifactLimit(RuntimeError):pass

class ArtifactStore:
    # Limits are compressed disk bytes; raw serialization is separately bounded to 64 MB.
    # A full project scan takes ~3 s, longer than a BFCL job. Reuse it for RESCAN_SECONDS and
    # add every block this store wrote since; the batch monitor scans independently.
    RESCAN_SECONDS=30
    def __init__(self,directory,total_limit=64000000,job_limit=2000000,disk_usage=None,clock=time.monotonic):
        self.clock,self._scanned_at,self._scanned,self._since=clock,None,0,0
        self.directory=Path(directory)
        if self.directory.is_symlink():raise ValueError('ARTIFACT_SYMLINK')
        self.directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        os.chmod(self.directory,0o700)
        self.total_limit,self.job_limit=total_limit,job_limit
        self.disk_usage=disk_usage or current_disk_usage
    def write(self,name,value):
        if not re.fullmatch(r'[a-zA-Z0-9_-]+',name):raise ValueError('ARTIFACT_NAME')
        raw=json.dumps(value,ensure_ascii=False,default=str).encode()
        if len(raw)>64000000:raise ArtifactLimit('ARTIFACT_RAW_LIMIT')
        compressed=gzip.compress(raw,mtime=0)
        allocated=((len(compressed)+4095)//4096)*4096
        now=self.clock()
        if self._scanned_at is None or now-self._scanned_at>=self.RESCAN_SECONDS:
            try:
                self._scanned=self.disk_usage()
            except Exception:
                raise ArtifactLimit('ARTIFACT_RESOURCE_UNKNOWN') from None
            self._scanned_at,self._since=now,0
        current_bytes=self._scanned+self._since
        if len(compressed)>self.job_limit or sum(p.stat().st_size for p in self.directory.iterdir())+len(compressed)>self.total_limit or current_bytes+allocated+2000000>DISK_STOP:
            raise ArtifactLimit('ARTIFACT_CAPACITY')
        path=self.directory/(name+'.json.gz');temporary=self.directory/(name+'.pending')
        # Only one compressed inode exists: rename is atomic, without a duplicate final copy.
        fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:
            with os.fdopen(fd,'wb') as stream:stream.write(compressed);stream.flush();os.fsync(stream.fileno())
            if path.exists():raise FileExistsError('ARTIFACT_EXISTS')
            os.rename(temporary,path)
            self._since+=allocated
        finally:
            if temporary.exists():temporary.unlink()
        return {'file':path.name,'sha256':hashlib.sha256(compressed).hexdigest(),'raw_sha256':hashlib.sha256(raw).hexdigest(),'compressed_bytes':len(compressed),'raw_bytes':len(raw)}

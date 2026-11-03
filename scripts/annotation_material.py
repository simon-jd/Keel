"""Read-only historical BFCL verification and blind cohort preparation. No model calls.

Trusted production roots are fixed here. Tests exercise disposable in-memory fixtures.
Current execution admission (provenance.verify_execution) is intentionally untouched.
"""
import copy
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'services/bench-adapters'))
from provenance import canonical_hash, validate_resume
MANIFEST='.tools/benchmark-matrix-0dbe966.json'
RESULTS='.tools/benchmark-matrix-0dbe966-results.jsonl'
ACTIVE='.tools/benchmark-artifacts'
ARCHIVE='.tools/benchmark-artifact-archive/formal-airline-retail-0dbe966'
INDEX=ARCHIVE+'.index.json'
MANIFEST_SHA='166c959cb9fde8330887e2bdff3a417d484af2b276263e2423f9ac2f7f77f45e'
INDEX_SHA='851e8b6b36a1033b7bfe5bfc82ca39104702f4f79ebaa78c7bd959537858296f'
IMPLEMENTATION_SHA='864bcdb6dbaeb31487173c3a0f6697af401ca9c19d5fd08612f3db24516c44f1'
PROTOCOL='bfcl-single-turn-v1'
SELECTION='sha256(bfcl-single-turn-v1:primary:contentHash), lexical ascending; secondary uses secondary salt'

def sha(data):return hashlib.sha256(data).hexdigest()
def encoded(value):return json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()
def require(condition,code):
    if not condition:raise ValueError(code)

def owned(path,directory=False,source_metadata=False):
    # Check every directory component beneath the workspace, not just the leaf.
    path=Path(path)
    for parent in path.parents:
        if parent==ROOT:break
        require(not parent.is_symlink(),'SYMLINK_PARENT')
    info=path.lstat()
    require(info.st_uid==os.getuid() and not stat.S_ISLNK(info.st_mode),'OWNER_OR_SYMLINK')
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode),'FILE_KIND')
    require((stat.S_IMODE(info.st_mode) in (0o600,0o640,0o644,0o660,0o664)) if source_metadata else stat.S_IMODE(info.st_mode)==(0o700 if directory else 0o600),'PRIVATE_MODE')
    return info

def read_private(path,limit,source_metadata=False):
    info=owned(path,source_metadata=source_metadata);require(info.st_size<=limit,'FILE_LIMIT')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as stream:
        require(os.fstat(stream.fileno()).st_ino==info.st_ino,'FILE_CHANGED')
        data=stream.read(limit+1)
    require(len(data)==info.st_size and len(data)<=limit,'FILE_LIMIT')
    return data

def write_private(path,data):
    owned(path.parent,True)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as stream:
        stream.write(data);stream.flush();os.fsync(stream.fileno())
    fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)

def historical_identity(manifest):
    require(manifest.get('schema')==3,'MANIFEST_SCHEMA')
    identity=manifest['implementation'];files=identity['files'];names=set()
    require(isinstance(files,list) and files,'EMPTY_IMPLEMENTATION')
    for item in files:
        name=item['path'];path=Path(name)
        require(not path.is_absolute() and '..' not in path.parts and name not in names,'IMPLEMENTATION_PATH')
        require(bool(re.fullmatch('[0-9a-f]{64}',item['sha256'])),'IMPLEMENTATION_HASH')
        names.add(name)
    require(canonical_hash(files)==identity['sha256'],'HISTORICAL_IMPLEMENTATION_HASH')

def verify_index(index,marker,source,lines,rows,manifest_raw,manifest):
    require(marker=={'schema':1,'index_sha256':INDEX_SHA,'artifacts':311,'compressed_bytes':41_071_806},'COMPLETE_BINDING')
    require(index['schema']==1 and index['active_root']==ACTIVE and index['archive_root']==ARCHIVE,'INDEX_ROOT')
    require(index['manifest_sha256']==sha(manifest_raw) and index['implementation_sha256']==manifest['implementation']['sha256'],'INDEX_SOURCE')
    size=index['source_snapshot_bytes']
    require(type(size) is int and 0<size<=len(source) and source[:size].endswith(b'\n') and sha(source[:size])==index['source_prefix_sha256'],'SOURCE_PREFIX_DRIFT')
    selected=[r for r in rows if r.get('domain') in ('airline','retail')]
    require(len(selected)==len(index['entries'])==311,'INDEX_COUNT')
    names=set()
    for entry,row in zip(index['entries'],selected):
        name=entry['basename'];require(name not in names and name==row['artifact']['file']==row['run_id']+'.json.gz' and Path(name).name==name,'INDEX_BASENAME')
        names.add(name)
        require((entry['job_id'],entry['run_id'],entry['attempt'],entry['artifact'])==(row['job_id'],row['run_id'],row['attempt'],row['artifact']),'INDEX_ROW')
        line=entry['source_line_number'];require(type(line) is int and 0<=line<len(lines),'INDEX_LINE')
        require(sha(lines[line])==entry['source_line_sha256'] and json.loads(lines[line])==row,'INDEX_LINE_HASH')
    require(sum(e['artifact']['compressed_bytes'] for e in index['entries'])==index['compressed_bytes']==41_071_806,'INDEX_BYTES')

def decode_gzip(compressed,limit=64_000_000):
    import io
    with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:raw=stream.read(limit+1)
    require(len(raw)<=limit,'RAW_LIMIT')
    return raw

def artifact(row,directory):
    ref=row['artifact'];name=ref['file']
    require(bool(re.fullmatch('[0-9a-f-]{36}\\.json\\.gz',name)) and name==row['run_id']+'.json.gz','ARTIFACT_BASENAME')
    compressed=read_private(directory/name,2_000_000)
    require(len(compressed)==ref['compressed_bytes'] and sha(compressed)==ref['sha256'],'COMPRESSED_HASH')
    raw=decode_gzip(compressed)
    require(len(raw)==ref['raw_bytes'] and len(raw)<=64_000_000 and sha(raw)==ref['raw_sha256'],'RAW_HASH')
    value=json.loads(raw)
    require(value['metadata']=={k:v for k,v in row.items() if k!='artifact'} and value['human_labels'] is None,'ARTIFACT_METADATA')
    return value

def blind_unit(value):
    exchanges=value.get('exchanges',[]);require(len(exchanges)==1,'NOT_SINGLE_TURN')
    request=exchanges[0]['request'];response=exchanges[0]['response'];messages=request.get('messages');tools=request.get('tools')
    require(isinstance(messages,list) and messages and all(isinstance(m,dict) and m.get('role') in ('system','user') and isinstance(m.get('content'),str) and set(m)=={'role','content'} for m in messages),'UNSUPPORTED_HISTORY')
    require(isinstance(tools,list),'MISSING_TOOLS')
    require(not response.get('error') and not response.get('invalidToolCalls'),'INCOMPLETE_ACTION')
    action=copy.deepcopy(response.get('action'));require(isinstance(action,dict) and set(action)=={'role','content','toolCalls'} and action['role']=='assistant' and isinstance(action['content'],str) and isinstance(action['toolCalls'],list),'INCOMPLETE_ACTION')
    ids=set()
    for i,call in enumerate(action['toolCalls']):
        require(set(call)=={'id','name','args'} and isinstance(call['id'],str) and call['id'] and call['id'] not in ids and isinstance(call['name'],str),'INVALID_TRANSPORT_ID')
        ids.add(call['id']);call['id']=f'tool-call-{i+1}'
    return {'input':{'messages':copy.deepcopy(messages),'tools':copy.deepcopy(tools)},'action':action}

def select(population,primary_count=300,secondary_count=100):
    require(type(primary_count) is int and type(secondary_count) is int and 0<secondary_count<=primary_count<=len(population),'COHORT_COUNTS')
    keyed={}
    for unit,audit in population:
        digest=sha(encoded(unit));require(digest not in keyed,'DUPLICATE_CONTENT');keyed[digest]=(unit,audit)
    ordered=sorted(keyed,key=lambda h:(sha(f'{PROTOCOL}:primary:{h}'.encode()),h))[:primary_count]
    primary=[];audit=[]
    for digest in ordered:
        unit,source=keyed[digest];identity=sha(f'{PROTOCOL}:blind:{digest}'.encode())
        primary.append({'id':identity,**unit});audit.append({'id':identity,'contentHash':digest,'source':source})
    secondary=sorted((x['id'] for x in primary),key=lambda h:(sha(f'{PROTOCOL}:secondary:{h}'.encode()),h))[:secondary_count]
    return primary,secondary,audit

def historical_population():
    """Fixed historical sources only; not admission to execute the old manifest."""
    # Production trust anchors cannot be supplied or replaced by CLI parameters.
    for name in ('.tools/benchmark-artifact-archive',ACTIVE,ARCHIVE):owned(ROOT/name,True)
    require(not os.path.lexists(ROOT/(ARCHIVE+'.pending.json')),'PENDING_BLOCKS_READ')
    manifest_raw=read_private(ROOT/MANIFEST,2_000_000,True)
    manifest=json.loads(manifest_raw);require(canonical_hash(manifest)==MANIFEST_SHA,'MANIFEST_TRUST_ANCHOR');historical_identity(manifest);require(manifest['implementation']['sha256']==IMPLEMENTATION_SHA,'IMPLEMENTATION_TRUST_ANCHOR')
    source=read_private(ROOT/RESULTS,32_000_000,True)
    require(len(source)==10_780_899 and sha(source)=='3fbacb6de864310bc707970ff99979a7e133cdb8a36ffea775ac5526f86f490a' and source[:10_780_899].endswith(b'\n'),'FINAL_SOURCE_PREFIX_DRIFT')
    lines=source.splitlines();rows=[json.loads(l) for l in lines]
    validate_resume(manifest,rows)
    index_raw=read_private(ROOT/INDEX,2_000_000);require(sha(index_raw)==INDEX_SHA,'INDEX_TRUST_ANCHOR')
    index=json.loads(index_raw);marker=json.loads(read_private(ROOT/(ARCHIVE+'.complete.json'),4096))
    verify_index(index,marker,source,lines,rows,manifest_raw,manifest)
    require(set(p.name for p in (ROOT/ARCHIVE).iterdir())==set(e['basename'] for e in index['entries']),'SEALED_DIRECTORY_DRIFT')
    # Closed segment: unique original locations, inode identity and compressed hashes.
    for entry in index['entries']:
        name=entry['basename'];path=ROOT/ARCHIVE/name
        require(not os.path.lexists(ROOT/ACTIVE/name),'AMBIGUOUS_ROOT')
        info=owned(path);require((info.st_dev,info.st_ino)==(entry['dev'],entry['inode']),'ARCHIVE_INODE')
        data=read_private(path,2_000_000);require(len(data)==entry['artifact']['compressed_bytes'] and sha(data)==entry['artifact']['sha256'],'ARCHIVE_COMPRESSED_HASH')
    population=[];rejected=0
    for number,row in enumerate(rows):
        if row['benchmark']!='bfcl':continue
        require(row['status']=='completed','BFCL_NOT_TERMINAL')
        require(not os.path.lexists(ROOT/ARCHIVE/row['artifact']['file']),'AMBIGUOUS_ROOT')
        value=artifact(row,ROOT/ACTIVE)
        try:unit=blind_unit(value)
        except ValueError:rejected+=1;continue
        population.append((unit,{'jobId':row['job_id'],'runId':row['run_id'],'attempt':row['attempt'],'sourceLine':number,'sourceLineHash':sha(lines[number]),'artifact':row['artifact'],'manifestHash':row['manifest_hash'],'implementationHash':row['implementation_sha256'],'executionGitSha':row['execution_git_sha'],'model':row['model'],'datasetCommit':row['dataset_commit']}))
    require(len(population)==400 and rejected==0,'EXPECTED_400_COMPLETE_DISTINCT_BFCL')
    require(read_private(ROOT/MANIFEST,2_000_000,True)==manifest_raw and read_private(ROOT/RESULTS,32_000_000,True)==source,'SOURCE_CHANGED_DURING_READ')
    return population,manifest_raw,source

def prepare(verify_only=False):
    population,manifest_raw,source=historical_population()
    primary,secondary,audit=select(population)
    protocol=json.loads(subprocess.check_output([str(ROOT/'node_modules/.bin/tsx'),'services/api/src/routes/label.ts','protocol'],cwd=ROOT,text=True))
    directory=ROOT/'.tools/annotation-task9'
    primary_bytes=b''.join(encoded(x)+b'\n' for x in primary);by_id={x['id']:x for x in primary}
    secondary_bytes=b''.join(encoded(by_id[x])+b'\n' for x in secondary)
    audit_bytes=encoded(audit)+b'\n'
    binding={'schema':1,'protocol':PROTOCOL,'selection':SELECTION,'population':400,'primaryIds':[x['id'] for x in primary],'secondaryIds':secondary,'primaryHash':sha(primary_bytes),'secondaryHash':sha(secondary_bytes),'auditHash':sha(audit_bytes),'rubricVersion':protocol['rubric']['version'],'rubricHash':protocol['rubricHash'],'promptVersions':['v1','v2'],'promptHashes':protocol['promptHashes'],'manifestSha256':sha(manifest_raw),'sourceSnapshotSha256':sha(source),'sourceSnapshotBytes':len(source),'implementationSha256':IMPLEMENTATION_SHA,'indexSha256':INDEX_SHA,'humanLabels':0}
    binding['cohortHash']=sha(encoded(binding))
    files=[('primary.blind.jsonl',primary_bytes),('secondary.blind.jsonl',secondary_bytes),('source.audit.json',audit_bytes),('cohort.json',encoded(binding)+b'\n'),('primary.labels.jsonl',b''),('secondary.labels.jsonl',b'')]
    if verify_only:
        owned(directory,True)
        for name,data in files[:4]:require(read_private(directory/name,8_000_000)==data,'FROZEN_EXPORT_DRIFT')
        for name,_ in files[4:]:owned(directory/name)
    else:
        directory.mkdir(mode=0o700);owned(directory,True)
        for name,data in files:write_private(directory/name,data)
    require(read_private(ROOT/MANIFEST,2_000_000,True)==manifest_raw and read_private(ROOT/RESULTS,32_000_000,True)==source,'SOURCE_CHANGED_DURING_EXPORT')
    print(json.dumps({'state':'verified' if verify_only else 'prepared','population':400,'primary':300,'secondary':100,'humanLabelsAtPreparation':0,'cohortHash':binding['cohortHash'],'privateDirectory':str(directory.relative_to(ROOT)),'bytes':sum(p.stat().st_size for p in directory.iterdir())}))

if __name__=='__main__':
    try:
        require(sys.argv[1:] in (['prepare'],['verify']),'USAGE: annotation_material.py prepare|verify')
        prepare(verify_only=sys.argv[1]=='verify')
    except (ValueError,OSError,KeyError,TypeError,json.JSONDecodeError):
        print('ANNOTATION_PREPARATION_FAILED (sources unchanged; inspect privately)',file=sys.stderr);sys.exit(1)

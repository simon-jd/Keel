"""Deterministic export and CPU AST replay of fixed historical BFCL failures.

No roots or source bindings are caller configurable. Public files contain metadata;
full source payloads remain in a private 0700/0600 directory. No inference/network.
"""
import json
import os
import subprocess
from pathlib import Path
import socket
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
import annotation_material as history
from annotation_material import ROOT,sha,encoded,require,owned,read_private,write_private
import regression_identity as identity
PRIVATE=identity.PRIVATE
SUPERSEDED=ROOT/'.tools/regression-task10'
SUPERSEDED_COMMIT='46a3b1d0eb7e84242fbc537021da5ec5b3000ad9'
PUBLIC=ROOT/'data/regression'
VERSION='bfcl-source-action-v1:transport-toolcall-id-only'

def select_cases(records):
    cases=[];seen=set();ids=set()
    for unit,source,value in records:
        row=value['metadata'];benchmark=value['benchmark'];identity=sha(encoded(unit))
        require(identity not in seen and row['task_id'] not in ids,'DUPLICATE_REGRESSION_CASE')
        seen.add(identity);ids.add(row['task_id'])
        require(row['status']=='completed' and type(row['success']) is bool and type(benchmark['verdict']['valid']) is bool and row['success']==benchmark['verdict']['valid'],'INVALID_ORIGINAL_VERDICT')
        require(benchmark['entry']['id']==row['task_id'] and 'response' in benchmark and 'ground_truth' in benchmark,'MISSING_REPLAY_MATERIAL')
        cases.append({'id':row['task_id'],'seed':row['seed'],'taskHash':row['task_hash'],'semanticHash':identity,'canonicalization':VERSION,'originalSuccess':row['success'],'source':source,'original':value})
    return sorted(cases,key=lambda x:(sha(('task10:'+x['semanticHash']).encode()),x['id']))

def public_cases(cases,secret):
    return sorted(cases,key=lambda c:identity.commit(secret,'case',c['semanticHash']))

def public_index(cases,secret):
    return [{'id':identity.commit(secret,'case',c['semanticHash']),'seed':c['seed'],'taskHash':identity.commit(secret,'task',c['taskHash']),'semanticCommitment':identity.commit(secret,'semantic',c['semanticHash']),'canonicalization':VERSION,'originalSuccess':c['originalSuccess'],'labelOrigin':'original-BFCL-AST'} for c in public_cases(cases,secret)]

def mapping_bytes(cases,secret):
    return encoded([{'publicId':identity.commit(secret,'case',c['semanticHash']),'publicTaskHash':identity.commit(secret,'task',c['taskHash']),'sourceTaskHash':c['taskHash'],'sourceSemanticHash':c['semanticHash'],'sourceTaskId':c['id']} for c in public_cases(cases,secret)])+b'\n'

def material(creating=False):
    secret=identity.key()
    population,manifest_raw,source=history.historical_population()
    rows=[json.loads(line) for line in source.splitlines()]
    records=[(unit,audit,history.artifact(rows[audit['sourceLine']],ROOT/history.ACTIVE)) for unit,audit in population]
    cases=select_cases(records)
    require(len(cases)==400 and sum(not c['originalSuccess'] for c in cases)==176,'EXPECTED_400_WITH_176_FAILURES')
    if not creating:require(read_private(PRIVATE/'public-map.json',2_000_000)==mapping_bytes(cases,secret),'IDENTITY_MAP_CHANGED')
    # Recheck frozen sources after the second payload read.
    require(read_private(ROOT/history.MANIFEST,2_000_000,True)==manifest_raw and read_private(ROOT/history.RESULTS,32_000_000,True)==source,'SOURCE_CHANGED_DURING_EXPORT')
    private=b''.join(encoded(c)+b'\n' for c in cases)
    indexes=public_index(cases,secret)
    validation=b''.join(encoded(c)+b'\n' for c in indexes)
    failures=b''.join(encoded(c)+b'\n' for c in indexes if not c['originalSuccess'])
    binding={'schema':2,'identityAlgorithm':identity.VERSION,'kind':'historical-output-replay','canonicalization':VERSION,'population':400,'regressions':176,'successControls':224,'human_evidence':False,'label_origin':'original-BFCL-AST','manifestSha256':sha(manifest_raw),'manifestCanonicalSha256':history.MANIFEST_SHA,'sourceSha256':sha(source),'sourceBytes':len(source),'implementationSha256':history.IMPLEMENTATION_SHA,'archiveIndexSha256':history.INDEX_SHA,'privateCasesSha256':sha(private),'validationIndexSha256':sha(validation),'failureIndexSha256':sha(failures),'selection':'all unique complete original BFCL failures; sha256(task10:semanticHash) order; complete 400 validation population'}
    return cases,private,validation,failures,encoded(binding)+b'\n'

def superseded_evidence():
    owned(SUPERSEDED,True)
    prior=[]
    for path in sorted(SUPERSEDED.iterdir()):
        data=read_private(path,8_000_000);info=path.stat()
        prior.append({'path':str(path.relative_to(ROOT)),'sha256':sha(data),'bytes':len(data),'inode':info.st_ino,'mtimeNs':info.st_mtime_ns})
    public=[]
    for name in ('bfcl-validation.jsonl','bfcl-failures.jsonl','binding.json','baseline-report.json','baseline-proof.json'):
        path=PUBLIC/name;data=read_private(path,2_000_000,True)
        committed=subprocess.check_output(['git','show',SUPERSEDED_COMMIT+':'+str(path.relative_to(ROOT))],cwd=ROOT)
        require(data==committed,'SUPERSEDED_PUBLIC_DRIFT')
        public.append({'path':str(path.relative_to(ROOT)),'sha256':sha(data),'bytes':len(data)})
    return {'schema':1,'state':'superseded privacy-vulnerable unkeyed v1; retained privately and in local Git only','commit':SUPERSEDED_COMMIT,'privateFiles':prior,'publicFiles':public}

def verify_superseded():
    owned(SUPERSEDED,True)
    prior=json.loads(read_private(PRIVATE/'superseded.json',32768))
    require(prior['commit']==SUPERSEDED_COMMIT,'SUPERSEDED_COMMIT')
    require({x['path'] for x in prior['privateFiles']}=={str(p.relative_to(ROOT)) for p in SUPERSEDED.iterdir()},'SUPERSEDED_FILE_LIST')
    for item in prior['privateFiles']:
        path=ROOT/item['path'];require(path.parent==SUPERSEDED,'SUPERSEDED_PATH')
        data=read_private(path,8_000_000);info=path.stat()
        require((sha(data),len(data),info.st_ino,info.st_mtime_ns)==(item['sha256'],item['bytes'],item['inode'],item['mtimeNs']),'SUPERSEDED_PRIVATE_DRIFT')
    names={'bfcl-validation.jsonl','bfcl-failures.jsonl','binding.json','baseline-report.json','baseline-proof.json'}
    require({x['path'] for x in prior['publicFiles']}=={str((PUBLIC/name).relative_to(ROOT)) for name in names},'SUPERSEDED_PUBLIC_LIST')
    for item in prior['publicFiles']:
        data=subprocess.check_output(['git','show',SUPERSEDED_COMMIT+':'+item['path']],cwd=ROOT)
        require((sha(data),len(data))==(item['sha256'],item['bytes']),'SUPERSEDED_GIT_DRIFT')

def replace_public(path,data):
    # Only fixed Task10 derivative destinations; never a source/artifact root.
    require(path.parent==PUBLIC and not PUBLIC.is_symlink() and not PUBLIC.parent.is_symlink(),'PUBLIC_PATH')
    read_private(path,2_000_000,True)
    temporary=path.with_name(path.name+'.v2.tmp')
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
    with os.fdopen(fd,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
    os.replace(temporary,path)

def export(verify=False):
    prior=None
    if not verify:
        prior=superseded_evidence()
        identity.create() # exclusive generation, never implicit in a read/verify
    cases,private,validation,failures,binding=material(creating=not verify)
    secret=identity.key()
    mapping=mapping_bytes(cases,secret)
    baseline_data,proof=baseline_files(cases,secret,binding)
    files=[(PRIVATE/'cases.jsonl',private),(PRIVATE/'public-map.json',mapping),(PUBLIC/'bfcl-validation.jsonl',validation),(PUBLIC/'bfcl-failures.jsonl',failures),(PUBLIC/'binding.json',binding),(PUBLIC/'baseline-report.json',baseline_data),(PUBLIC/'baseline-proof.json',proof)]
    if verify:
        owned(PRIVATE,True)
        verify_superseded()
        for path,data in files:require(read_private(path,16_000_000,source_metadata=path.parent==PUBLIC)==data,'FROZEN_REGRESSION_DRIFT')
    else:
        write_private(PRIVATE/'superseded.json',encoded(prior)+b'\n')
        for path,data in files:
            if path.parent==PRIVATE:write_private(path,data)
            else:replace_public(path,data)
    print(json.dumps({'state':'verified' if verify else 'exported-v2','population':len(cases),'failures':176,'successControls':224,'privateBytes':len(private),'bindingSha256':sha(binding),'identityAlgorithm':identity.VERSION,'actualInference':False}))

def baseline_files(cases,secret,binding):
    manifest=json.loads(read_private(ROOT/history.MANIFEST,2_000_000,True))
    runs=[]
    for case in public_cases(cases,secret):
        row=case['original']['metadata'];calls=row['calls']
        require(calls and all(isinstance(c.get('accounting'),dict) for c in calls),'MISSING_CALL_ACCOUNTING')
        accounting=[c['accounting'] for c in calls]
        known=all(a['costStatus']=='known' for a in accounting)
        subtotal=sum(a['costUsd'] for a in accounting)
        require(subtotal==row['cost_known_usd'] and row['cost_status']==('known' if known else 'unknown'),'COST_ACCOUNTING_DRIFT')
        # Call cost already includes every physical retry; never add attempt cost twice.
        for call in accounting:
            require(call['attempts'] and call['costStatus']==('unknown' if any(a['costStatus']=='unknown' for a in call['attempts']) else 'known'),'ATTEMPT_COST_STATUS_DRIFT')
            require(abs(sum(a.get('costUsd',0) for a in call['attempts'])-call['costUsd'])<1e-12,'ATTEMPT_COST_SUBTOTAL_DRIFT')
        runs.append({'id':identity.commit(secret,'case',case['semanticHash']),'runId':identity.commit(secret,'run',row['run_id']),'taskHash':identity.commit(secret,'task',case['taskHash']),'status':row['status'],'success':case['originalSuccess'],'costUsd':subtotal,'costStatus':row['cost_status']})
    requests=[c['original']['exchanges'][0]['request'] for c in cases]
    settings={k:manifest['model'][k] for k in ('temperature','thinking','tool_parser','max_tokens')}
    report={'execution':{'implementation':history.IMPLEMENTATION_SHA,'prompt':sha(encoded(requests)),'policy':'historical-local-only','models':[sha(encoded(manifest['model']))]},'population':{'dataset':manifest['dataset_commits']['bfcl'],'protocol':history.PROTOCOL,'scorer':'BFCL-original-AST:'+manifest['dataset_commits']['bfcl'],'settings':sha(encoded(settings)),'seed':0},'runs':runs}
    data=encoded(report)+b'\n'
    proof=encoded({'schema':1,'kind':'actual-historical-400-baseline','reportSha256':sha(data),'materialBindingSha256':sha(binding),'population':400,'successes':224,'failures':176,'knownApiCostUsd':sum(r['costUsd'] for r in runs),'costStatus':'known' if all(r['costStatus']=='known' for r in runs) else 'unknown','actualInference':'retained Task8 outputs; no new inference'})+b'\n'
    return data,proof

def baseline():
    cases,_,_,_,binding=material()
    data,proof=baseline_files(cases,identity.key(),binding)
    for name,content in [('baseline-report.json',data),('baseline-proof.json',proof)]:
        require(read_private(PUBLIC/name,2_000_000,True)==content,'BASELINE_REPORT_DRIFT')
    print(proof.decode().strip())

def replay():
    # Verify against frozen original sources, not a mutable public index alone.
    cases,private,validation,failures,binding=material()
    owned(PRIVATE,True)
    require(read_private(PRIVATE/'cases.jsonl',16_000_000)==private,'FROZEN_REGRESSION_DRIFT')
    for name,data in [('bfcl-validation.jsonl',validation),('bfcl-failures.jsonl',failures),('binding.json',binding)]:
        require(read_private(PUBLIC/name,2_000_000,True)==data,'FROZEN_REGRESSION_INDEX_DRIFT')
    pin='6ea57973c7a6097fd7c5915698c54c17c5b1b6c8'
    upstream=ROOT/f'.tools/bench-upstream/gorilla-{pin}'
    manifest=json.loads(read_private(ROOT/history.MANIFEST,2_000_000,True))
    prefix=str(upstream.relative_to(ROOT))+'/berkeley-function-call-leaderboard/bfcl_eval/'
    expected=[x for x in manifest['implementation']['files'] if x['path'].startswith(prefix)]
    require(expected and manifest['dataset_commits']['bfcl']==pin,'SCORER_BINDING_MISSING')
    def verify_scorer():
        actual={str(p.relative_to(ROOT)) for p in (ROOT/prefix).rglob('*.py')}
        require(actual=={x['path'] for x in expected},'SCORER_FILE_LIST_DRIFT')
        for item in expected:require(sha(read_private(ROOT/item['path'],2_000_000,True))==item['sha256'],'SCORER_SOURCE_DRIFT')
    adapter=next(x for x in manifest['implementation']['files'] if x['path']=='services/bench-adapters/bfcl_runner.py')
    verify_scorer()
    require(sha(read_private(ROOT/adapter['path'],2_000_000,True))==adapter['sha256'],'SCORER_ADAPTER_DRIFT')
    sys.path.insert(0,str((ROOT/prefix).parent))
    def denied(*_args,**_kwargs):raise RuntimeError('REPLAY_NETWORK_DENIED')
    original_connect,original_connect_ex=socket.socket.connect,socket.socket.connect_ex
    socket.socket.connect=denied;socket.socket.connect_ex=denied
    try:
        from bfcl_runner import KeelBFCLHandler,evaluate_ast
        import bfcl_eval
        require(Path(bfcl_eval.__file__).resolve()==(ROOT/prefix/'__init__.py').resolve(),'SCORER_IMPORT_DRIFT')
        handler=KeelBFCLHandler(None)
        for case in cases:
            benchmark=case['original']['benchmark']
            result=evaluate_ast(handler,benchmark['entry'],benchmark['response'],benchmark['ground_truth'])
            require(result['valid']==case['originalSuccess'],'AST_REPLAY_MISMATCH')
    finally:socket.socket.connect=original_connect;socket.socket.connect_ex=original_connect_ex
    verify_scorer()
    require(sha(read_private(ROOT/adapter['path'],2_000_000,True))==adapter['sha256'],'SCORER_ADAPTER_DRIFT')
    receipt={'schema':1,'kind':'historical-output-AST-replay','population':400,'failures':176,'successes':224,'mismatches':0,'bindingSha256':sha(binding),'scorerCommit':pin,'scorerSourceSha256':sha(encoded(expected)),'actualInference':False,'network':'denied'}
    path=PRIVATE/'replay.json';data=encoded(receipt)+b'\n'
    if path.exists():require(read_private(path,4096)==data,'REPLAY_RECEIPT_DRIFT')
    else:write_private(path,data)
    print(json.dumps(receipt))

if __name__=='__main__':
    try:
        require(sys.argv[1:] in (['export'],['verify'],['replay'],['baseline']),'USAGE: regression_material.py export|verify|replay|baseline')
        if sys.argv[1]=='baseline':baseline()
        elif sys.argv[1]=='replay':replay()
        else:export(sys.argv[1]=='verify')
    except (ValueError,OSError,KeyError,TypeError,json.JSONDecodeError,subprocess.CalledProcessError):
        print('REGRESSION_MATERIAL_FAILED (inspect privately)',file=sys.stderr);sys.exit(1)

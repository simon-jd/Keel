"""Distinct Task9 serial admission. No credentials, provider clients, refunds or recovery."""
from datetime import datetime, timezone
from decimal import Decimal, localcontext, ROUND_CEILING
import hashlib
import hmac
import json
from pathlib import Path
import re
import secrets
import uuid
from urllib.parse import urlparse
import budget as b

POLICY = json.loads((Path(__file__).resolve().parents[1] / 'packages/models/src/task9-judge-policy.json').read_text())
PHASE, ENDPOINT, DEPLOYMENT, COHORT = (POLICY[k] for k in ('phase', 'endpoint', 'deployment', 'cohortHash'))
REFERENCE_HASHES, RUBRIC_HASH, PROMPT_HASHES = (POLICY[k] for k in ('referenceSourceHashes', 'rubricHash', 'promptHashes'))

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()).hexdigest()

SERIALIZER_HASH = digest(POLICY)

def now():return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

def estimate(quote, *, expired=False):
    # Validate official quote identity/freshness, then evaluate the released formula in Decimal.
    b.quote_estimate(quote,1,1,1,allow_expired=expired)
    with localcontext() as context:
        context.prec=80;context.rounding=ROUND_CEILING
        input_price=b.money(quote['input_usd_per_unit']);output_price=b.money(quote['output_usd_per_unit'])
        ordinary=4096*input_price+1024*output_price
        terminal=1048576*input_price+32768*output_price
        return (624*ordinary+terminal).quantize(Decimal('0.000000001'),rounding=ROUND_CEILING)

def add_money(left,right):
    with localcontext() as context:
        context.prec=80;context.rounding=ROUND_CEILING
        return left+right

def binding_check(binding, quote):
    expected={k:POLICY[k] for k in ('phase','endpoint','deployment','model','version','region','sku','upgradePolicy','alias','cohortHash','referenceSourceHashes','rubricHash','promptHashes')}
    expected.update(reference_origin='subagent',human_evidence=False,human_reference_gate_fulfilled=False,serializerHash=SERIALIZER_HASH)
    keys=set(expected)|{'quote_id','quoteHash','referenceAuditHash','gitSha','implementationSha256','jobs','wireHash'}
    if not isinstance(binding,dict) or set(binding)!=keys or any(binding.get(k)!=v or (isinstance(v,bool) and type(binding.get(k)) is not bool) for k,v in expected.items()):
        raise ValueError('Wrong Task9 fixed profile.')
    source=urlparse(quote.get('source',''))
    if source.scheme!='https' or source.hostname!='prices.azure.com' or source.path!='/api/retail/prices':raise ValueError('Task9 requires Azure Retail Prices source.')
    if binding.get('quoteHash')!=digest(quote):raise ValueError('Task9 full quote hash mismatch.')
    if (quote.get('provider')!='azure' or any(binding[k]!=quote.get(k) for k in ('model','version','region','sku','quote_id'))
            or not isinstance(binding['quote_id'],str) or not binding['quote_id']):raise ValueError('Task9 quote identity mismatch.')
    for key,length in [('referenceAuditHash',64),('gitSha',40),('implementationSha256',64),('wireHash',64)]:
        if not isinstance(binding[key],str) or not re.fullmatch('[0-9a-f]{'+str(length)+'}',binding[key]):raise ValueError('Malformed Task9 provenance.')
    jobs=binding['jobs']
    if not isinstance(jobs,list) or len(jobs)!=605 or digest(jobs)!=binding['wireHash']:raise ValueError('Task9 wire order mismatch.')
    ids=[]
    for i,job in enumerate(jobs):
        if (not isinstance(job,dict) or set(job)!={'logical','kind','promptVersion','sampleId','requestHash'}
                or type(job['logical']) is not int or job['logical']!=i
                or job['kind']!=('reproduce' if i<5 else 'judge')
                or job['promptVersion']!=('v1' if i<305 else 'v2')
                or not isinstance(job['sampleId'],str) or not job['sampleId']
                or not isinstance(job['requestHash'],str) or not re.fullmatch('[0-9a-f]{64}',job['requestHash'])):raise ValueError('Malformed Task9 job.')
        if 5<=i<305:ids.append(job['sampleId'])
    if len(set(ids))!=300 or any(j['sampleId']!=ids[0] or j['requestHash']!=jobs[5]['requestHash'] for j in jobs[:5]) or [j['sampleId'] for j in jobs[305:]]!=ids:
        raise ValueError('Task9 logical population/order mismatch.')

def validate_item(item, *, fresh=False):
    binding_check(item['binding'],item['quote'])
    if (item.get('phase')!=PHASE or item.get('profile_sha256')!=SERIALIZER_HASH
            or item.get('estimate_usd')!=str(estimate(item['quote'],expired=not fresh))
            or item.get('binding_sha256')!=digest(item['binding'])
            or any(item.get(k)!=v or type(item.get(k)) is not int for k,v in {'ordinary_input_estimate':4096,'ordinary_output_estimate':1024,'full_input_ceiling':1048576,'full_output_ceiling':32768,'physical_ceiling':625}.items())):
        raise ValueError('Task9 reserved estimate/provenance mismatch.')
    if (item.get('attempts') or item['status'] in ('running','completed')) and not re.fullmatch('[0-9a-f]{64}',item.get('claim_sha256','')):raise ValueError('Task9 claim audit missing.')
    entries=item.get('attempts')
    if not isinstance(entries,list) or len(entries)>625:raise ValueError('Task9 attempt ceiling.')
    logical=invalid=0;known=Decimal(0);unknown=False;pending=0
    for i,a in enumerate(entries):
        if (not isinstance(a,dict) or a.get('attempt')!=i+1 or type(a.get('attempt')) is not int
                or a.get('logical')!=logical or type(a.get('logical')) is not int or logical>=605
                or a.get('request_hash')!=item['binding']['jobs'][logical]['requestHash']
                or type(a.get('settled')) is not bool):raise ValueError('Task9 attempt order drift.')
        b.utc(a['consumed_at'])
        if not a['settled']:
            pending+=1;unknown=True
            if i!=len(entries)-1 or a.get('cost_status')!='unknown':raise ValueError('Multiple/nonterminal Task9 pending exposures.')
            continue
        outcome=a.get('outcome')
        if outcome not in ('valid','invalid-schema','failed'):raise ValueError('Task9 settlement outcome.')
        usage=a.get('usage')
        valid_usage=isinstance(usage,dict) and set(usage)=={'input','output'} and all(type(usage[k]) is int and usage[k]>=0 for k in usage)
        if a.get('cost_status')=='known':
            if not valid_usage:raise ValueError('Known Task9 cost requires valid usage.')
            cost=usage_cost(item['quote'],usage)
            if b.money(a.get('cost_usd'))!=cost:raise ValueError('Task9 cost drift.')
            known=add_money(known,cost)
        elif a.get('cost_status')=='unknown':
            if usage is not None or 'cost_usd' in a:raise ValueError('Unknown Task9 cost cannot become zero.')
            unknown=True
        else:raise ValueError('Task9 cost status.')
        ordinary=valid_usage and usage['input']<=4096 and usage['output']<=1024
        if outcome=='invalid-schema':invalid+=1
        if ordinary and outcome=='valid':logical+=1
        terminal=not ordinary or outcome=='failed' or (outcome=='invalid-schema' and (logical<5 or invalid>20))
        if terminal and (i!=len(entries)-1 or item['status']!='failed'):raise ValueError('Dispatch after terminal Task9 settlement.')
    if (pending>1 or item.get('next_logical')!=logical or type(item.get('next_logical')) is not int
            or item.get('invalid_schema_count')!=invalid or type(item.get('invalid_schema_count')) is not int
            or b.money(item.get('known_cost_usd'))!=known or item.get('cost_status')!=('unknown' if unknown else 'known')):
        raise ValueError('Task9 accounting/denominator drift.')
    if item['status']=='reserved' and (entries or 'claim_sha256' in item):raise ValueError('Task9 cannot reopen a phase.')
    if item['status']=='completed' and (logical!=605 or pending):raise ValueError('Partial Task9 is not complete.')
    if item['status']=='failed' and not isinstance(item.get('stop_reason'),str):raise ValueError('Task9 stop must be durable.')
    return item

def usage_cost(quote,usage):
    with localcontext() as context:
        context.prec=80;context.rounding=ROUND_CEILING
        return b.money(quote['input_usd_per_unit'])*usage['input']+b.money(quote['output_usd_per_unit'])*usage['output']

def reserve(path,quote,binding):
    binding_check(binding,quote);amount=estimate(quote)
    with b.locked_ledger(path) as p:
        ledger=json.loads(p.read_text());total=b.validate_ledger(ledger)
        cumulative=add_money(total,amount)
        if any(r.get('phase')==PHASE for r in ledger['reservations']) or cumulative>b.LIMIT:raise ValueError('Task9 duplicate phase or cumulative gate exceeded.')
        item=dict(id=str(uuid.uuid4()),phase=PHASE,profile_sha256=SERIALIZER_HASH,status='reserved',created_at=now(),estimate_usd=str(amount),quote=quote,binding=binding,binding_sha256=digest(binding),ordinary_input_estimate=4096,ordinary_output_estimate=1024,full_input_ceiling=1048576,full_output_ceiling=32768,physical_ceiling=625,attempts=[],next_logical=0,invalid_schema_count=0,known_cost_usd='0',cost_status='known')
        validate_item(item,fresh=True);ledger['reservations'].append(item);b.atomic_write(p,ledger)
        return dict(reservation_id=item['id'],estimate_usd=str(amount),total_usd=str(cumulative))

def find(ledger,rid,token=None,*,fresh=False):
    b.validate_ledger(ledger)
    item=next((r for r in ledger['reservations'] if r['id']==rid and r.get('phase')==PHASE),None)
    if item is None:raise ValueError('Task9 reservation missing.')
    validate_item(item,fresh=fresh)
    if token is not None and (not isinstance(token,str) or not hmac.compare_digest(item.get('claim_sha256',''),hashlib.sha256(token.encode()).hexdigest())):raise ValueError('Task9 claim mismatch.')
    return item

def claim(path,reservation_id,binding):
    with b.locked_ledger(path) as p:
        ledger=json.loads(p.read_text());item=find(ledger,reservation_id,fresh=True)
        if item['status']!='reserved' or item['binding']!=binding:raise ValueError('Task9 single-use claim denied.')
        token=secrets.token_hex(32);item.update(status='running',claim_sha256=hashlib.sha256(token.encode()).hexdigest());b.atomic_write(p,ledger)
        return dict(claim_token=token,input_per_million=str(b.money(item['quote']['input_usd_per_unit'])*1000000),output_per_million=str(b.money(item['quote']['output_usd_per_unit'])*1000000))

def stop(p,ledger,item,reason):
    item.update(status='failed',stop_reason=reason,finished_at=now());b.atomic_write(p,ledger)

def consume(path,reservation_id,claim_token,binding_sha256,logical,request_hash):
    with b.locked_ledger(path) as p:
        ledger=json.loads(p.read_text());item=find(ledger,reservation_id,claim_token)
        if item['status']!='running' or item['binding_sha256']!=binding_sha256:raise ValueError('Task9 phase is stopped or binding mismatched.')
        if any(not a['settled'] for a in item['attempts']):
            stop(p,ledger,item,'pending-attempt; no crash/concurrent recovery');raise ValueError('Task9 pending exposure; permanently stopped.')
        validate_item(item,fresh=True)
        if (type(logical) is not int or logical!=item['next_logical'] or logical>=605
                or request_hash!=item['binding']['jobs'][logical]['requestHash']):raise ValueError('Task9 ordered logical identity mismatch.')
        retries=len(item['attempts'])-item['next_logical']
        # Initial attempt of each logical is free of retry allocation; every repeated invalid consumes one extra slot.
        repeated=bool(item['attempts'] and item['attempts'][-1]['logical']==logical)
        if len(item['attempts'])>=625 or (repeated and retries>20):
            stop(p,ledger,item,'physical/recovery ceiling exhausted');raise ValueError('budget_exhausted')
        number=len(item['attempts'])+1
        item['attempts'].append(dict(attempt=number,logical=logical,request_hash=request_hash,cost_status='unknown',settled=False,consumed_at=now()))
        item['cost_status']='unknown';b.atomic_write(p,ledger);return dict(attempt=number)

def settle(path,reservation_id,claim_token,attempt,usage,outcome):
    with b.locked_ledger(path) as p:
        ledger=json.loads(p.read_text());item=find(ledger,reservation_id,claim_token)
        if type(attempt) is not int or not 1<=attempt<=len(item['attempts']):raise ValueError('Unknown Task9 attempt.')
        a=item['attempts'][attempt-1]
        if a['settled'] or attempt!=len(item['attempts']):raise ValueError('Task9 settlement is single-use and serial.')
        valid=isinstance(usage,dict) and set(usage)=={'input','output'} and all(type(usage[k]) is int and usage[k]>=0 for k in usage)
        a.update(settled=True,outcome=outcome if outcome in ('valid','invalid-schema','failed') else 'failed')
        if valid:
            cost=usage_cost(item['quote'],usage);a.update(cost_status='known',usage=usage,cost_usd=str(cost));item['known_cost_usd']=str(add_money(b.money(item['known_cost_usd']),cost))
        ordinary=valid and usage['input']<=4096 and usage['output']<=1024
        if a['outcome']=='invalid-schema':item['invalid_schema_count']+=1
        if ordinary and a['outcome']=='valid':item['next_logical']+=1
        item['cost_status']='unknown' if any(x['cost_status']=='unknown' for x in item['attempts']) else 'known'
        terminal=not ordinary or a['outcome']=='failed' or (a['outcome']=='invalid-schema' and (a['logical']<5 or item['invalid_schema_count']>20))
        if terminal:stop(p,ledger,item,'unknown/invalid/overrun usage or terminal outcome')
        else:
            if item['status']=='running' and item['next_logical']==605:item['status']='completed';item['finished_at']=now()
            b.atomic_write(p,ledger)
        if terminal:raise ValueError('Task9 terminal settlement; stopped.')
        return dict(known_cost_usd=item['known_cost_usd'],cost_status=item['cost_status'],next_logical=item['next_logical'],status=item['status'])

def abort(path,reservation_id):
    """Operator closure only after the caller confirms its process tree has stopped. No resume/refund."""
    with b.locked_ledger(path) as p:
        ledger=json.loads(p.read_text());item=find(ledger,reservation_id)
        if item['status']=='completed':raise ValueError('Completed Task9 phase is immutable.')
        if item['status']!='failed':stop(p,ledger,item,'operator-abort; process tree confirmed stopped; no resume')
        return dict(reservation_id=item['id'],status='failed',estimate_usd=item['estimate_usd'],cost_status=item['cost_status'],physical_attempts=len(item['attempts']))

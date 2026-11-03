"""Task9 CPU fixtures: durable serial exposure and exact Decimal contingency."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
from pathlib import Path
import sys
import tempfile
import unittest
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import budget
import judge_budget as judge

class JudgeBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)/'ledger.json'
        self.path.write_text(json.dumps(dict(schema_version=1,project='keel',currency='USD',project_limit_usd='10',gate_usd='9',reservations=[])))
        now=datetime.now(timezone.utc)
        self.quote=dict(kind='commercial_api',provider='azure',currency='USD',unit='token',source='https://prices.azure.com/api/retail/prices',quoted_at=(now-timedelta(seconds=1)).isoformat().replace('+00:00','Z'),valid_until=(now+timedelta(hours=1)).isoformat().replace('+00:00','Z'),model='gpt-4.1-mini',version='2025-04-14',region='westus',sku='GlobalStandard',quote_id='synthetic-retail',input_usd_per_unit='0.0000004',output_usd_per_unit='0.0000016')
        jobs=[]
        for i in range(605):
            index=0 if i<5 else (i-5)%300
            jobs.append(dict(logical=i,kind='reproduce' if i<5 else 'judge',promptVersion='v1' if i<305 else 'v2',sampleId=f'fixture-{index}',requestHash=f'{index+(0 if i<305 else 300):064x}'))
        self.binding=dict(phase=judge.PHASE,endpoint=judge.ENDPOINT,deployment=judge.DEPLOYMENT,model='gpt-4.1-mini',version='2025-04-14',region='westus',sku='GlobalStandard',upgradePolicy='NoAutoUpgrade',alias='azureJudge',quote_id=self.quote['quote_id'],quoteHash=judge.digest(self.quote),cohortHash=judge.COHORT,reference_origin='subagent',human_evidence=False,human_reference_gate_fulfilled=False,referenceAuditHash='a'*64,referenceSourceHashes=judge.REFERENCE_HASHES,rubricHash=judge.RUBRIC_HASH,promptHashes=judge.PROMPT_HASHES,serializerHash=judge.SERIALIZER_HASH,gitSha='b'*40,implementationSha256='c'*64,jobs=jobs)
        self.binding['wireHash']=judge.digest(jobs)
    def reserve(self):
        result=judge.reserve(self.path,self.quote,self.binding)
        token=judge.claim(self.path,result['reservation_id'],self.binding)['claim_token']
        return result['reservation_id'],token
    def consume(self,rid,token,logical=0):
        return judge.consume(self.path,rid,token,judge.digest(self.binding),logical,self.binding['jobs'][logical]['requestHash'])['attempt']
    def item(self):return json.loads(self.path.read_text())['reservations'][-1]
    def test_exact_reserve_and_prior_spend_are_retained(self):
        self.assertEqual(judge.estimate(self.quote),Decimal('2.516582400'))
        old_quote={**self.quote,'region':'eastus','quote_id':'synthetic-old-retail'}
        old_binding=dict(endpoint='https://keel-old-fixture.openai.azure.com/openai/v1',deployment='keel-mini',model='gpt-4.1-mini',version='2025-04-14',region='eastus',sku='GlobalStandard',quote_id=old_quote['quote_id'],request_hashes=['a'*64])
        old_id=budget.reserve_commercial(self.path,old_quote,old_binding)['reservation_id']
        old_token=budget.claim_commercial(self.path,old_id,old_binding)['claim_token']
        for _ in range(10):budget.consume_commercial(self.path,old_id,old_token,old_binding,'a'*64)
        old_item=json.loads(self.path.read_text())['reservations'][0]
        rid,token=self.reserve();self.assertTrue(rid and token)
        self.assertEqual(budget.validate_ledger(json.loads(self.path.read_text())),Decimal('6.739654400'))
        with self.assertRaises(ValueError):judge.reserve(self.path,self.quote,self.binding)
        judge.abort(self.path,rid)
        self.assertEqual(json.loads(self.path.read_text())['reservations'][0],old_item)
        with self.assertRaises(ValueError):budget.consume_commercial(self.path,old_id,old_token,old_binding,'a'*64)
        with self.assertRaises(ValueError):judge.abort(self.path,old_id)
        with self.assertRaises(ValueError):budget.recover_commercial_undispatched(self.path,rid)
    def test_concurrent_consume_has_at_most_one_physical_and_durable_stop(self):
        rid,token=self.reserve()
        def go(_):
            try:return self.consume(rid,token)
            except ValueError:return None
        with ThreadPoolExecutor(max_workers=8) as pool:results=list(pool.map(go,range(12)))
        self.assertEqual(sum(r is not None for r in results),1)
        self.assertEqual(len(self.item()['attempts']),1);self.assertEqual(self.item()['status'],'failed')
        judge.settle(self.path,rid,token,1,{'input':2,'output':1},'valid')
        with self.assertRaises(ValueError):self.consume(rid,token,1)
    def test_crash_pending_unknown_invalid_and_overrun_can_never_reopen(self):
        for usage in [None,{'input':True,'output':1},{'input':4097,'output':1},{'input':1,'output':1025}]:
            with self.subTest(usage=usage):
                self.setUp();rid,token=self.reserve();number=self.consume(rid,token)
                with self.assertRaises(ValueError):judge.settle(self.path,rid,token,number,usage,'valid')
                self.assertEqual(self.item()['status'],'failed')
                with self.assertRaises(ValueError):self.consume(rid,token,1)
                with self.assertRaises(ValueError):judge.claim(self.path,rid,self.binding)
        self.setUp();rid,token=self.reserve();self.consume(rid,token)
        with self.assertRaises(ValueError):self.consume(rid,token,1)
        self.assertEqual(self.item()['cost_status'],'unknown');self.assertEqual(self.item()['status'],'failed')
    def test_exact_order_and_only_known_schema_recovery_for_judge(self):
        rid,token=self.reserve()
        with self.assertRaises(ValueError):self.consume(rid,token,1)
        for logical in range(5):
            n=self.consume(rid,token,logical);judge.settle(self.path,rid,token,n,{'input':3,'output':2},'valid')
        for _ in range(20):
            n=self.consume(rid,token,5);judge.settle(self.path,rid,token,n,{'input':3,'output':2},'invalid-schema')
        n=self.consume(rid,token,5)
        with self.assertRaises(ValueError):judge.settle(self.path,rid,token,n,{'input':3,'output':2},'invalid-schema')
        with self.assertRaises(ValueError):self.consume(rid,token,5)
        self.assertEqual(len(self.item()['attempts']),26);self.assertEqual(self.item()['invalid_schema_count'],21)
        self.assertEqual(self.item()['estimate_usd'],'2.516582400')
    def test_complete_605_ordered_and_625_physical_ceiling_preserves_denominators(self):
        rid,token=self.reserve()
        for logical in range(605):
            if logical==5:
                for _ in range(20):
                    n=self.consume(rid,token,logical);judge.settle(self.path,rid,token,n,{'input':1,'output':1},'invalid-schema')
            n=self.consume(rid,token,logical);judge.settle(self.path,rid,token,n,{'input':1,'output':1},'valid')
        item=self.item();self.assertEqual(item['status'],'completed');self.assertEqual(item['next_logical'],605)
        self.assertEqual(len(item['attempts']),625);self.assertEqual(item['invalid_schema_count'],20)
        self.assertEqual(Decimal(item['known_cost_usd']),Decimal('0.0012500'))
        with self.assertRaises(ValueError):self.consume(rid,token,604)
        with self.assertRaises(ValueError):judge.abort(self.path,rid)
    def test_reproduction_invalid_has_no_retry_and_retains_known_cost(self):
        rid,token=self.reserve();n=self.consume(rid,token)
        with self.assertRaises(ValueError):judge.settle(self.path,rid,token,n,{'input':2,'output':1},'invalid-schema')
        item=self.item();self.assertEqual(item['invalid_schema_count'],1);self.assertEqual(item['cost_status'],'known')
        self.assertEqual(Decimal(item['known_cost_usd']),Decimal('0.0000024'))
        with self.assertRaises(ValueError):self.consume(rid,token)
    def test_wrong_profile_tamper_prices_and_cumulative_fail_closed(self):
        for key,value in [('phase','task8'),('endpoint','https://other.openai.azure.com/openai/v1'),('cohortHash','e'*64),('human_evidence',True),('serializerHash','e'*64),('version','other'),('promptHashes',{})]:
            with self.assertRaises(ValueError):judge.reserve(self.path,self.quote,{**self.binding,key:value})
        with self.assertRaises(ValueError):judge.reserve(self.path,{**self.quote,'input_usd_per_unit':'0.004'},self.binding)
        rid,token=self.reserve();ledger=json.loads(self.path.read_text());ledger['reservations'][0]['estimate_usd']='0';self.path.write_text(json.dumps(ledger))
        with self.assertRaises(ValueError):self.consume(rid,token)
        with self.assertRaises(ValueError):budget.validate_ledger(ledger)

    def test_operator_abort_is_new_phase_only_idempotent_and_never_refunds_or_settles(self):
        rid,token=self.reserve();n=self.consume(rid,token)
        before=self.item();judge.abort(self.path,rid)
        after=self.item();self.assertEqual(after['status'],'failed');self.assertEqual(after['attempts'],before['attempts'])
        self.assertEqual(after['estimate_usd'],before['estimate_usd']);self.assertEqual(after['cost_status'],'unknown')
        self.assertEqual(judge.abort(self.path,rid)['status'],'failed')
        with self.assertRaises(ValueError):self.consume(rid,token,1)
        with self.assertRaises(ValueError):judge.abort(self.path,'wrong-phase')

    def test_abort_zero_dispatch_and_settled_partial_retains_all_history(self):
        for dispatched in (False,True):
            with self.subTest(dispatched=dispatched):
                self.setUp();rid,token=self.reserve()
                if dispatched:
                    n=self.consume(rid,token);judge.settle(self.path,rid,token,n,{'input':2,'output':1},'valid')
                before=self.item();judge.abort(self.path,rid);after=self.item()
                for key in ('attempts','known_cost_usd','cost_status','estimate_usd','next_logical'):
                    self.assertEqual(after[key],before[key])
                self.assertEqual(after['status'],'failed')
                with self.assertRaises(ValueError):judge.claim(self.path,rid,self.binding)

    def test_quote_hash_is_immutable_and_known_settlement_survives_natural_expiry(self):
        from unittest.mock import patch
        rid,token=self.reserve();n=self.consume(rid,token)
        class Later(datetime):
            @classmethod
            def now(cls,tz=None):return datetime.now(timezone.utc)+timedelta(hours=2)
        with patch.object(budget,'datetime',Later):
            judge.settle(self.path,rid,token,n,{'input':2,'output':1},'valid')
            with self.assertRaises(ValueError):self.consume(rid,token,1)
        ledger=json.loads(self.path.read_text());ledger['reservations'][0]['quote']['input_usd_per_unit']='0.0000003';self.path.write_text(json.dumps(ledger))
        with self.assertRaises(ValueError):budget.validate_ledger(ledger)

    def test_fresh_full_quote_and_cumulative_gate_cannot_be_replaced_by_correct_rehash(self):
        for patch in ({'input_usd_per_unit':'0.004'},{'source':'https://azure.microsoft.com/pricing'},{'valid_until':'2000-01-01T00:00:00Z'}):
            q={**self.quote,**patch};binding={**self.binding,'quoteHash':judge.digest(q)}
            with self.assertRaises(ValueError):judge.reserve(self.path,q,binding)
        ledger=json.loads(self.path.read_text());ledger['reservations'].append(dict(id='prior',status='failed',estimate_usd='6.6'));self.path.write_text(json.dumps(ledger))
        with self.assertRaises(ValueError):judge.reserve(self.path,self.quote,self.binding)
        self.assertEqual(len(json.loads(self.path.read_text())['reservations']),1)

    def test_generic_finish_cannot_complete_or_reopen_partial_judge(self):
        rid,token=self.reserve();before=self.item()
        with self.assertRaises(ValueError):budget.finish(self.path,rid,True)
        self.assertEqual(self.item(),before)

    def test_arbitrarily_small_cumulative_excess_does_not_round_down_to_gate(self):
        amount=judge.estimate(self.quote)
        with budget.localcontext() as context:
            context.prec=80
            prior=Decimal(9)-amount+Decimal('1e-60')
        ledger=json.loads(self.path.read_text());ledger['reservations'].append(dict(id='prior',status='failed',estimate_usd=str(prior)));self.path.write_text(json.dumps(ledger))
        with self.assertRaises(ValueError):judge.reserve(self.path,self.quote,self.binding)

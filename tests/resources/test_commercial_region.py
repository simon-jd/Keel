"""Disposable-only zero-dispatch regional amendment fixtures; no Azure calls."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import sys
import threading
import unittest
import test_commercial_budget as fixtures
budget=fixtures.budget
ROOT=fixtures.ROOT

class CommercialRegionTests(unittest.TestCase):
    def setUp(self):
        fixtures.CommercialBudgetTests.setUp(self)
        self.binding['request_hashes']=['a'*64,'b'*64]
        self.west={**self.binding,'endpoint':'https://keel-west-fixture.openai.azure.com/openai/v1','region':'westus','quote_id':'fixture-west-meters'}
        self.west_quote={**self.quote,'region':'westus','quote_id':self.west['quote_id']}
    def reserve(self):return budget.reserve_commercial(self.path,self.quote,self.binding)['reservation_id']
    def rebind(self,rid,quote=None,binding=None):return budget.rebind_commercial_unstarted(self.path,rid,quote or self.west_quote,binding or self.west)
    def read(self):return json.loads(self.path.read_text())
    def test_rebind_retains_id_exposure_hashes_caps_and_audits_original(self):
        rid=self.reserve();before=self.read();original=deepcopy(before['reservations'][0])
        result=self.rebind(rid)
        after=self.read();item=after['reservations'][0]
        self.assertEqual(result['reservation_id'],rid)
        self.assertEqual(budget.validate_ledger(before),budget.validate_ledger(after))
        for key in original.keys()-{'binding','quote'}:self.assertEqual(item[key],original[key],key)
        self.assertEqual(item['binding'],self.west);self.assertEqual(item['quote'],self.west_quote)
        audit=item['regional_rebinds'][0]
        self.assertEqual(audit['from_binding'],original['binding']);self.assertEqual(audit['from_quote'],original['quote'])
        self.assertEqual(audit['reason'],'azure_subscription_region_policy_eastus_to_westus')
        self.assertLessEqual(budget.utc(audit['rebound_at']),datetime.now(timezone.utc))
        self.assertNotIn('claim_sha256',item);self.assertEqual(item['attempts'],[])
        with self.assertRaises(ValueError):budget.claim_commercial(self.path,rid,self.binding)
        token=budget.claim_commercial(self.path,rid,self.west)['claim_token']
        for _ in range(10):budget.consume_commercial(self.path,rid,token,self.west,'a'*64)
        with self.assertRaisesRegex(ValueError,'budget_exhausted'):budget.consume_commercial(self.path,rid,token,self.west,'a'*64)
        self.assertEqual(self.read()['reservations'][0]['estimate_usd'],'4.223072000')
        exhausted=subprocess.run([sys.executable,str(ROOT/'scripts/budget.py'),'--ledger',str(self.path),'commercial-rpc'],input=json.dumps(dict(action='consume',reservation_id=rid,claim_token=token,binding=self.west,request_hash='a'*64)),text=True,capture_output=True,timeout=10)
        self.assertEqual(exhausted.returncode,1);self.assertEqual(json.loads(exhausted.stdout)['error'],'budget_exhausted')
    def test_rejects_rebind_for_any_claim_attempt_or_tampered_policy_without_mutation(self):
        rid=self.reserve();pristine=self.read()
        changes=[{'status':status} for status in ('running','completed','failed')]+[
            {'claim_sha256':''},{'claim_token':'fixture'},{'claim':False},{'claimed_at':'2000-01-01T00:00:00Z'},{'finished_at':'2000-01-01T00:00:00Z'},
            {'attempts':[{'attempt':1,'cost_status':'unknown'}]},{'phase':'other'},
            {'requests':9},{'max_input_tokens':100},{'max_output_tokens':4096},{'max_body_bytes':65536},{'n':2},{'n':True},
            {'known_cost_usd':'0.01'},{'cost_status':'unknown'},{'regional_rebinds':[]},
            {'binding':self.west,'quote':self.west_quote}]
        for change in changes:
            with self.subTest(change=change):
                ledger=deepcopy(pristine);ledger['reservations'][0].update(change);self.path.write_text(json.dumps(ledger));raw=self.path.read_bytes()
                with self.assertRaises((ValueError,TypeError,KeyError)):self.rebind(rid)
                self.assertEqual(self.path.read_bytes(),raw)
        self.path.write_text(json.dumps(pristine));self.rebind(rid)
    def test_rejects_generic_repeat_and_direct_westus_reservation(self):
        generic=budget.reserve(self.path,self.quote,1,1,1)['reservation_id'];before=self.path.read_bytes()
        with self.assertRaises(ValueError):self.rebind(generic)
        self.assertEqual(self.path.read_bytes(),before)
        with self.assertRaises(ValueError):budget.reserve_commercial(self.path,self.west_quote,self.west)
        rid=self.reserve();self.rebind(rid);before=self.path.read_bytes()
        for binding,quote in [(self.west,self.west_quote),(self.binding,self.quote)]:
            with self.assertRaises(ValueError):self.rebind(rid,quote,binding)
            self.assertEqual(self.path.read_bytes(),before)
    def test_rejects_binding_quote_and_price_changes_even_when_estimate_stays_equal(self):
        rid=self.reserve();before=self.path.read_bytes()
        bad_bindings=[{**self.west,**change} for change in (
            {'region':'centralus'},{'region':'eastus'},{'model':'gpt-4.1-nano'},{'sku':'Standard'},
            {'version':'2026-01-01'},{'deployment':'other'},{'request_hashes':list(reversed(self.binding['request_hashes']))},
            {'request_hashes':['c'*64]},{'endpoint':'http://keel-west-fixture.openai.azure.com/openai/v1'})]
        bad_quotes=[{**self.west_quote,**change} for change in (
            {'input_usd_per_unit':'0.0000005'},{'output_usd_per_unit':'0.0000017'},
            {'input_usd_per_unit':'0.000000400002048','output_usd_per_unit':'0.000001598952424'},
            {'input_usd_per_unit':'NaN'},{'input_usd_per_unit':'-1'},{'model':'gpt-4.1-nano'},
            {'version':'2026-01-01'},{'sku':'Standard'},{'region':'eastus'},{'quote_id':'wrong'},
            {'source':'https://untrusted.invalid/prices'},{'currency':'EUR'},{'unit':'1K'},
            {'quoted_at':'2099-01-01T00:00:00Z'},{'valid_until':'2000-01-01T00:00:00Z'},
            {'valid_until':'not-UTC'})]
        self.assertEqual(budget.quote_estimate(bad_quotes[2],1047576,2048,10),budget.quote_estimate(self.quote,1047576,2048,10))
        for binding,quote in [(b,self.west_quote) for b in bad_bindings]+[(self.west,q) for q in bad_quotes]:
            with self.subTest(binding=binding,quote=quote):
                with self.assertRaises((ValueError,TypeError,KeyError)):self.rebind(rid,quote,binding)
                self.assertEqual(self.path.read_bytes(),before)
    def test_westus_claim_requires_valid_durable_transition_history(self):
        rid=self.reserve();self.rebind(rid);pristine=self.read()
        changes=[None,[],[{},{}],[{**pristine['reservations'][0]['regional_rebinds'][0],'reason':'arbitrary'}],
                 [{**pristine['reservations'][0]['regional_rebinds'][0],'rebound_at':'not-UTC'}],
                 [{**pristine['reservations'][0]['regional_rebinds'][0],'from_binding':self.west}]]
        for history in changes:
            with self.subTest(history=history):
                ledger=deepcopy(pristine)
                if history is None:ledger['reservations'][0].pop('regional_rebinds')
                else:ledger['reservations'][0]['regional_rebinds']=history
                self.path.write_text(json.dumps(ledger));raw=self.path.read_bytes()
                with self.assertRaises((ValueError,TypeError,KeyError)):budget.claim_commercial(self.path,rid,self.west)
                self.assertEqual(self.path.read_bytes(),raw)
    def test_subprocess_claim_and_operator_rebind_are_mutually_exclusive(self):
        original=self.path.read_text()
        quote_path=Path(self.temp.name)/'west-quote.json';quote_path.write_text(json.dumps(self.west_quote))
        binding_path=Path(self.temp.name)/'west-binding.json';binding_path.write_text(json.dumps(self.west))
        for _ in range(4):
            self.path.write_text(original);rid=self.reserve();barrier=threading.Barrier(2)
            command=[sys.executable,str(ROOT/'scripts/budget.py'),'--ledger',str(self.path)]
            def claim():
                barrier.wait();return subprocess.run(command+['commercial-rpc'],input=json.dumps(dict(action='claim',reservation_id=rid,binding=self.binding)),text=True,capture_output=True,timeout=10)
            def rebind():
                barrier.wait();return subprocess.run(command+['rebind-commercial-unstarted','--reservation',rid,'--quote',str(quote_path),'--binding',str(binding_path)],text=True,capture_output=True,timeout=10)
            with ThreadPoolExecutor(max_workers=2) as pool:
                pending=[pool.submit(claim),pool.submit(rebind)];results=[job.result() for job in pending]
            self.assertEqual(sorted(r.returncode for r in results),[0,1])
            item=self.read()['reservations'][0];self.assertEqual(item['attempts'],[])
            if results[0].returncode==0:self.assertEqual(item['status'],'running');self.assertEqual(item['binding'],self.binding);self.assertNotIn('regional_rebinds',item)
            else:self.assertEqual(item['status'],'reserved');self.assertEqual(item['binding'],self.west);self.assertNotIn('claim_sha256',item)
    def test_operator_cli_only_rpc_cannot_rebind(self):
        rid=self.reserve();before=self.path.read_bytes()
        result=subprocess.run([sys.executable,str(ROOT/'scripts/budget.py'),'--ledger',str(self.path),'commercial-rpc'],input=json.dumps(dict(action='rebind',reservation_id=rid,quote=self.west_quote,binding=self.west)),text=True,capture_output=True,timeout=10)
        self.assertEqual(result.returncode,1);self.assertEqual(self.path.read_bytes(),before)

    def test_real_claim_and_unknown_attempt_cannot_rebind_or_erase_known_cost(self):
        rid=self.reserve();token=budget.claim_commercial(self.path,rid,self.binding)['claim_token']
        before=self.path.read_bytes()
        with self.assertRaises(ValueError):self.rebind(rid)
        self.assertEqual(self.path.read_bytes(),before)
        first=budget.consume_commercial(self.path,rid,token,self.binding,'a'*64)['attempt']
        budget.settle_commercial(self.path,rid,token,first,{'input':2,'output':1})
        budget.consume_commercial(self.path,rid,token,self.binding,'b'*64);before=self.path.read_bytes()
        with self.assertRaises(ValueError):self.rebind(rid)
        self.assertEqual(self.path.read_bytes(),before)
        item=self.read()['reservations'][0]
        self.assertEqual(item['known_cost_usd'],'0.0000024');self.assertEqual(item['cost_status'],'unknown');self.assertEqual(item['estimate_usd'],'4.223072000')

    def test_fresh_westus_quote_can_replace_expired_unstarted_evidence_without_losing_it(self):
        rid=self.reserve();ledger=self.read()
        old_quote=ledger['reservations'][0]['quote']
        now=datetime.now(timezone.utc)
        old_quote['quoted_at']=(now-timedelta(hours=2)).isoformat().replace('+00:00','Z')
        old_quote['valid_until']=(now-timedelta(hours=1)).isoformat().replace('+00:00','Z')
        ledger['reservations'][0]['created_at']=(now-timedelta(minutes=90)).isoformat().replace('+00:00','Z')
        self.path.write_text(json.dumps(ledger))
        self.rebind(rid)
        item=self.read()['reservations'][0]
        self.assertEqual(item['regional_rebinds'][0]['from_quote'],old_quote)
        self.assertEqual(item['quote'],self.west_quote);self.assertEqual(item['attempts'],[])
        budget.claim_commercial(self.path,rid,self.west)

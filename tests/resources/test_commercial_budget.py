"""Offline persistent commercial dispatch admission; never a price quote or paid run."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import budget

class CommercialBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'ledger.json'
        self.path.write_text(json.dumps(dict(schema_version=1, project='keel',currency='USD',project_limit_usd='10',gate_usd='9',reservations=[])))
        now = datetime.now(timezone.utc)
        self.quote = dict(kind='commercial_api',provider='azure',currency='USD',unit='token',source='https://prices.azure.com/api/retail/prices',quoted_at=(now-timedelta(seconds=1)).isoformat().replace('+00:00','Z'), valid_until=(now+timedelta(hours=1)).isoformat().replace('+00:00','Z'),model='gpt-4.1-mini',version='2025-04-14',region='eastus',sku='GlobalStandard',quote_id='fixture-meters',input_usd_per_unit='0.0000004',output_usd_per_unit='0.0000016')
        self.binding = dict(endpoint='https://keel-fixture.openai.azure.com/openai/v1',deployment='keel-mini',model=self.quote['model'],version=self.quote['version'],region=self.quote['region'],sku=self.quote['sku'],quote_id=self.quote['quote_id'],request_hashes=['a'*64])
    def reserve(self):
        return budget.reserve_commercial(self.path,self.quote,self.binding)['reservation_id']
    def test_no_claim_mismatch_expiry_and_duplicate_claim_fail_closed(self):
        rid=self.reserve()
        with self.assertRaises(ValueError):budget.consume_commercial(self.path,rid,'missing',self.binding,'a'*64)
        with self.assertRaises(ValueError):budget.claim_commercial(self.path,rid,{**self.binding,'deployment':'other'})
        token=budget.claim_commercial(self.path,rid,self.binding)['claim_token']
        with self.assertRaises(ValueError):budget.claim_commercial(self.path,rid,self.binding)
        with self.assertRaises(ValueError):budget.consume_commercial(self.path,rid,token,self.binding,'b'*64)
        ledger=json.loads(self.path.read_text());ledger['reservations'][0]['quote']['valid_until']='2000-01-01T00:00:00Z';self.path.write_text(json.dumps(ledger))
        with self.assertRaises(ValueError):budget.consume_commercial(self.path,rid,token,self.binding,'a'*64)
    def test_concurrent_and_new_process_cannot_reset_exhausted_counter(self):
        rid=self.reserve();token=budget.claim_commercial(self.path,rid,self.binding)['claim_token']
        def attempt(_):
            try:return budget.consume_commercial(self.path,rid,token,self.binding,'a'*64)
            except ValueError:return None
        with ThreadPoolExecutor(max_workers=12) as pool:results=list(pool.map(attempt,range(24)))
        self.assertEqual(sum(r is not None for r in results),10)
        command=[sys.executable,str(ROOT/'scripts/budget.py'),'--ledger',str(self.path),'commercial-rpc']
        payload=dict(action='consume',reservation_id=rid,claim_token=token,binding=self.binding,request_hash='a'*64)
        result=subprocess.run(command,input=json.dumps(payload),text=True,capture_output=True)
        self.assertNotEqual(result.returncode,0);self.assertIn('budget_exhausted',result.stdout)
        item=json.loads(self.path.read_text())['reservations'][0]
        self.assertEqual(len(item['attempts']),10);self.assertEqual(item['estimate_usd'],'4.223072000')
    def test_unknown_never_erases_known_subtotal_or_refunds(self):
        rid=self.reserve();token=budget.claim_commercial(self.path,rid,self.binding)['claim_token']
        first=budget.consume_commercial(self.path,rid,token,self.binding,'a'*64)['attempt']
        budget.settle_commercial(self.path,rid,token,first,{'input':2,'output':1})
        budget.consume_commercial(self.path,rid,token,self.binding,'a'*64)
        item=json.loads(self.path.read_text())['reservations'][0]
        self.assertEqual(item['known_cost_usd'],'0.0000024');self.assertEqual(item['cost_status'],'unknown')
        with self.assertRaises(ValueError):budget.settle_commercial(self.path,rid,token,first,{'input':0,'output':0})
        self.assertEqual(budget.validate_ledger(json.loads(self.path.read_text())),budget.Decimal('4.223072000'))

    def test_second_phase_reservation_is_not_an_attempt_counter_reset(self):
        self.reserve()
        with self.assertRaises(ValueError):self.reserve()
        self.assertEqual(len(json.loads(self.path.read_text())['reservations']),1)
    def test_known_usage_can_settle_after_quote_expiry_without_reopening_dispatch(self):
        rid=self.reserve();token=budget.claim_commercial(self.path,rid,self.binding)['claim_token']
        first=budget.consume_commercial(self.path,rid,token,self.binding,'a'*64)['attempt']
        ledger=json.loads(self.path.read_text());ledger['reservations'][0]['quote']['valid_until']='2000-01-01T00:00:00Z';self.path.write_text(json.dumps(ledger))
        budget.settle_commercial(self.path,rid,token,first,{'input':2,'output':1})
        with self.assertRaises(ValueError):budget.consume_commercial(self.path,rid,token,self.binding,'a'*64)
        self.assertEqual(json.loads(self.path.read_text())['reservations'][0]['known_cost_usd'],'0.0000024')

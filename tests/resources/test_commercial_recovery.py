"""Operator-only zero-dispatch claim recovery; disposable ledgers, never Azure."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import threading
import unittest
import test_commercial_budget as fixtures
budget=fixtures.budget
ROOT=fixtures.ROOT

class CommercialRecoveryTests(unittest.TestCase):
    def setUp(self):
        fixtures.CommercialBudgetTests.setUp(self)
        self.west={**self.binding,'region':'westus','quote_id':'fixture-west-quote'}
        self.west_quote={**self.quote,'region':'westus','quote_id':self.west['quote_id']}
    def read(self):return json.loads(self.path.read_text())
    def start(self):
        rid=budget.reserve_commercial(self.path,self.quote,self.binding)['reservation_id']
        budget.rebind_commercial_unstarted(self.path,rid,self.west_quote,self.west)
        token=budget.claim_commercial(self.path,rid,self.west)['claim_token']
        return rid,token
    def recover(self,rid):return budget.recover_commercial_undispatched(self.path,rid)
    def test_recovery_archives_exact_prior_claim_and_preserves_entire_original_exposure(self):
        rid,old=self.start();before=self.read();prior=deepcopy(before['reservations'][0]);result=self.recover(rid)
        item=self.read()['reservations'][0]
        self.assertEqual(result['reservation_id'],rid);self.assertEqual(budget.validate_ledger(before),budget.validate_ledger(self.read()))
        for key in prior.keys()-{'claim_sha256','status'}:self.assertEqual(item[key],prior[key],key)
        self.assertEqual(item['status'],'reserved');self.assertNotIn('claim_sha256',item)
        audit=item['claim_recoveries'][0]
        self.assertEqual(audit['reason'],'pre_dispatch_manifest_docs_only_head_mismatch');self.assertEqual(audit['prior_state'],prior)
        budget.utc(audit['recovered_at']);self.assertNotIn(old,self.path.read_text())
        with self.assertRaises(ValueError):budget.consume_commercial(self.path,rid,old,self.west,'a'*64)
        new=budget.claim_commercial(self.path,rid,self.west)['claim_token']
        self.assertNotEqual(new,old);self.assertNotEqual(self.read()['reservations'][0]['claim_sha256'],prior['claim_sha256'])
        with self.assertRaises(ValueError):budget.consume_commercial(self.path,rid,old,self.west,'a'*64)
        for _ in range(10):budget.consume_commercial(self.path,rid,new,self.west,'a'*64)
        with self.assertRaisesRegex(ValueError,'budget_exhausted'):budget.consume_commercial(self.path,rid,new,self.west,'a'*64)
        item=self.read()['reservations'][0];self.assertEqual(len(item['attempts']),10);self.assertEqual(item['estimate_usd'],prior['estimate_usd'])
    def test_known_or_unknown_consumed_attempts_cannot_recover_or_refund(self):
        for known in (False,True):
            with self.subTest(known=known):
                self.setUp();rid,token=self.start();number=budget.consume_commercial(self.path,rid,token,self.west,'a'*64)['attempt']
                if known:budget.settle_commercial(self.path,rid,token,number,{'input':2,'output':1})
                before=self.path.read_bytes()
                with self.assertRaises(ValueError):self.recover(rid)
                self.assertEqual(self.path.read_bytes(),before)
    def test_malformed_status_claim_quote_policy_and_recovery_markers_reject_without_write(self):
        rid,_=self.start();pristine=self.read()
        changes=[{'status':v} for v in ('reserved','completed','failed')]+[
            {'claim_sha256':None},{'claim_sha256':'bad'},{'claim_sha256':'z'*64},{'claim_token':'forbidden'},
            {'finished_at':'2000-01-01T00:00:00Z'},{'known_cost_usd':'0.01'},{'cost_status':'unknown'},
            {'requests':11},{'n':True},{'phase':'generic'},{'regional_rebinds':[]},{'claim_recoveries':[]},
            {'claim_recoveries':[{}]},{'claim_recovery_count':1},{'binding':self.binding,'quote':self.quote},
            {'quote':{**self.west_quote,'valid_until':'2000-01-01T00:00:00Z'}}]
        for change in changes:
            with self.subTest(change=change):
                ledger=deepcopy(pristine);ledger['reservations'][0].update(change);self.path.write_text(json.dumps(ledger));raw=self.path.read_bytes()
                with self.assertRaises((ValueError,TypeError,KeyError)):self.recover(rid)
                self.assertEqual(self.path.read_bytes(),raw)
        ledger=deepcopy(pristine);ledger['reservations'][0].pop('claim_sha256');self.path.write_text(json.dumps(ledger));raw=self.path.read_bytes()
        with self.assertRaises(ValueError):self.recover(rid)
        self.assertEqual(self.path.read_bytes(),raw)
    def test_repeat_and_tampered_recovery_audits_never_authorize_claim_or_consume(self):
        rid,old=self.start();self.recover(rid);recovered=self.read();raw=self.path.read_bytes()
        with self.assertRaises(ValueError):self.recover(rid)
        self.assertEqual(self.path.read_bytes(),raw)
        new=budget.claim_commercial(self.path,rid,self.west)['claim_token'];running=self.read();raw=self.path.read_bytes()
        with self.assertRaises(ValueError):self.recover(rid)
        self.assertEqual(self.path.read_bytes(),raw)
        for template,action in ((recovered,lambda:budget.claim_commercial(self.path,rid,self.west)),(running,lambda:budget.consume_commercial(self.path,rid,new,self.west,'a'*64))):
            prior=template['reservations'][0]['claim_recoveries'][0]['prior_state']
            corruptions=[None,[],[{}],[{**template['reservations'][0]['claim_recoveries'][0],'reason':'arbitrary'}],
                         [{**template['reservations'][0]['claim_recoveries'][0],'recovered_at':'not-UTC'}],
                         [{**template['reservations'][0]['claim_recoveries'][0],'prior_state':{**prior,'attempts':[{}]}}],
                         [{**template['reservations'][0]['claim_recoveries'][0],'prior_state':{**prior,'estimate_usd':'0'}}],
                         [{**template['reservations'][0]['claim_recoveries'][0],'prior_state':{**prior,'claim_sha256':'bad'}}]]
            for history in corruptions:
                with self.subTest(status=template['reservations'][0]['status'],history=history):
                    ledger=deepcopy(template)
                    if history is None:
                        ledger['reservations'][0].pop('claim_recoveries')
                    else:
                        ledger['reservations'][0]['claim_recoveries']=history
                        if len(history)==1 and isinstance(history[0],dict):ledger['reservations'][0]['claim_recovery_sha256']=budget.commercial_recovery_fingerprint(history[0])
                    self.path.write_text(json.dumps(ledger));raw=self.path.read_bytes()
                    with self.assertRaises((ValueError,TypeError,KeyError)):action()
                    self.assertEqual(self.path.read_bytes(),raw)
        self.path.write_text(json.dumps(running))
        ledger=self.read();ledger['reservations'][0]['claim_sha256']=hashlib.sha256(old.encode()).hexdigest();self.path.write_text(json.dumps(ledger));raw=self.path.read_bytes()
        with self.assertRaises(ValueError):budget.consume_commercial(self.path,rid,old,self.west,'a'*64)
        self.assertEqual(self.path.read_bytes(),raw)
    def test_subprocess_recovery_and_consume_have_one_winner_and_preserve_counter(self):
        original=self.path.read_text()
        for _ in range(4):
            self.path.write_text(original);rid,token=self.start();barrier=threading.Barrier(2)
            command=[sys.executable,str(ROOT/'scripts/budget.py'),'--ledger',str(self.path)]
            def consume():
                barrier.wait();return subprocess.run(command+['commercial-rpc'],input=json.dumps(dict(action='consume',reservation_id=rid,claim_token=token,binding=self.west,request_hash='a'*64)),text=True,capture_output=True,timeout=10)
            def recover():
                barrier.wait();return subprocess.run(command+['recover-commercial-undispatched','--reservation',rid],text=True,capture_output=True,timeout=10)
            with ThreadPoolExecutor(max_workers=2) as pool:
                pending=[pool.submit(consume),pool.submit(recover)];results=[job.result() for job in pending]
            self.assertEqual(sorted(r.returncode for r in results),[0,1])
            item=self.read()['reservations'][0]
            if results[0].returncode==0:self.assertEqual(len(item['attempts']),1);self.assertEqual(item['cost_status'],'unknown');self.assertNotIn('claim_recoveries',item)
            else:
                self.assertEqual(item['attempts'],[]);self.assertEqual(item['status'],'reserved')
                with self.assertRaises(ValueError):budget.consume_commercial(self.path,rid,token,self.west,'a'*64)
    def test_recovery_is_absent_from_commercial_rpc(self):
        rid,_=self.start();before=self.path.read_bytes()
        result=subprocess.run([sys.executable,str(ROOT/'scripts/budget.py'),'--ledger',str(self.path),'commercial-rpc'],input=json.dumps(dict(action='recover',reservation_id=rid)),text=True,capture_output=True,timeout=10)
        self.assertEqual(result.returncode,1);self.assertEqual(self.path.read_bytes(),before)

    def test_generic_and_non_amended_eastus_claims_remain_unrecoverable(self):
        generic=budget.reserve(self.path,self.quote,1,1,1)['reservation_id'];budget.claim(self.path,generic);before=self.path.read_bytes()
        with self.assertRaises(ValueError):self.recover(generic)
        self.assertEqual(self.path.read_bytes(),before)
        east=budget.reserve_commercial(self.path,self.quote,self.binding)['reservation_id'];budget.claim_commercial(self.path,east,self.binding);before=self.path.read_bytes()
        with self.assertRaises(ValueError):self.recover(east)
        self.assertEqual(self.path.read_bytes(),before)
    def test_new_claim_digest_cannot_repeat_archived_digest_even_if_random_source_collides(self):
        from unittest.mock import patch
        rid,old=self.start();self.recover(rid);before=self.path.read_bytes()
        with patch('secrets.token_hex',return_value=old):
            with self.assertRaises(ValueError):budget.claim_commercial(self.path,rid,self.west)
        self.assertEqual(self.path.read_bytes(),before)
    def test_settlement_validates_recovery_audit_and_retains_original_zero_attempt_snapshot(self):
        rid,_=self.start();self.recover(rid);token=budget.claim_commercial(self.path,rid,self.west)['claim_token']
        number=budget.consume_commercial(self.path,rid,token,self.west,'a'*64)['attempt'];valid=self.read()
        invalid=deepcopy(valid);invalid['reservations'][0]['claim_recoveries'][0]['prior_state']['known_cost_usd']='1'
        self.path.write_text(json.dumps(invalid));before=self.path.read_bytes()
        with self.assertRaises(ValueError):budget.settle_commercial(self.path,rid,token,number,{'input':2,'output':1})
        self.assertEqual(self.path.read_bytes(),before)
        self.path.write_text(json.dumps(valid));budget.settle_commercial(self.path,rid,token,number,{'input':2,'output':1})
        item=self.read()['reservations'][0];self.assertEqual(item['known_cost_usd'],'0.0000024');self.assertEqual(item['cost_status'],'known')
        self.assertEqual(item['claim_recoveries'][0]['prior_state']['attempts'],[])
    def test_valid_looking_prior_digest_tampering_does_not_authorize_a_new_claim(self):
        rid,_=self.start();self.recover(rid);ledger=self.read()
        ledger['reservations'][0]['claim_recoveries'][0]['prior_state']['claim_sha256']='a'*64
        self.path.write_text(json.dumps(ledger));before=self.path.read_bytes()
        with self.assertRaises(ValueError):budget.claim_commercial(self.path,rid,self.west)
        self.assertEqual(self.path.read_bytes(),before)

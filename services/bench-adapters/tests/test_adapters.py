"""Hand-authored HTTP fixture; never a benchmark score."""
import importlib.util
import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

class AdapterTests(unittest.TestCase):
    def test_tau2_adapter_roundtrip(self):
        self.assertIsNotNone(importlib.util.find_spec('keel_client'), 'Keel HTTP adapter is missing')
        from keel_client import KeelClient
        received = []
        class Fixture(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                received.append((self.path, self.headers.get('Authorization'), json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                body = json.dumps({'action': {'role': 'assistant', 'content': '', 'toolCalls': [{'id': 'call-1', 'name': 'lookup', 'args': {'id': 7}}]}, 'accounting': {'costUsd': 0, 'costStatus': 'known'}, 'call_id': 'fixture:1'}).encode()
                self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            client = KeelClient(f'http://127.0.0.1:{server.server_port}', 'fixture-token')
            result = client.step([{'role': 'system', 'content': 'original domain policy'}, {'role': 'tool', 'content': '{"ok":true}', 'toolCallId': 'prior-1'}], [{'name': 'lookup', 'parameters': {'type': 'object'}}])
            self.assertEqual(result['action']['toolCalls'], [{'id': 'call-1', 'name': 'lookup', 'args': {'id': 7}}])
            self.assertEqual(client.exchanges[0]['request']['messages'],received[0][2]['messages'])
            self.assertEqual(client.exchanges[0]['response']['action'],result['action'])
            self.assertNotIn('fixture-token',json.dumps(client.exchanges))
            self.assertEqual(received[0][0:2], ('/v1/agent/step', 'Bearer fixture-token'))
            self.assertEqual(received[0][2]['messages'][1]['toolCallId'], 'prior-1')
            self.assertEqual(received[0][2]['messages'][0]['content'], 'original domain policy')
        finally:
            server.shutdown(); server.server_close(); thread.join()

if __name__ == '__main__': unittest.main()

class DispatchLimitTests(unittest.TestCase):
    def test_exhausted_batch_limit_prevents_network_and_preserves_zero_dispatch(self):
        from keel_client import KeelClient
        from artifacts import ArtifactLimit
        client=KeelClient('http://127.0.0.1:18080','test-token',max_calls=0)
        with self.assertRaises(ArtifactLimit):client.step([{'role':'user','content':'synthetic'}])
        self.assertEqual(client.calls,0)
        self.assertEqual(client.records,[])

class ErrorAccountingTests(unittest.TestCase):
    def test_structured_http_failure_retains_accounting_without_provider_body(self):
        from keel_client import KeelClient
        from urllib.error import HTTPError
        import io
        client=KeelClient('http://127.0.0.1:18080','secret-test')
        class Opener:
            def open(self,*args,**kwargs):
                raise HTTPError('http://127.0.0.1:18080',502,'failure',{},io.BytesIO(json.dumps({'error':'INVALID_MODEL_RESPONSE','accounting':{'costUsd':0,'costStatus':'known'},'call_id':'fixed','prompt_hash':'hash','provider_body':'forbidden'}).encode()))
        client.opener=Opener()
        with self.assertRaisesRegex(RuntimeError,'KEEL_REQUEST_FAILED'):client.step([{'role':'user','content':'synthetic'}])
        self.assertEqual(client.records[0]['accounting']['costStatus'],'known')
        self.assertNotIn('forbidden',json.dumps(client.exchanges))
        self.assertNotIn('secret-test',json.dumps(client.exchanges))

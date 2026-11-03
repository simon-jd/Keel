"""Real loopback HTTP tests; scripts/with_pii_sidecar.py starts the real service (see `make test-pii`)."""
import json
import os
import unittest
from unittest.mock import patch
import contextlib
import io
import logging
from services.pii import app as service
import urllib.error
import urllib.request

ENDPOINT = os.environ.get('KEEL_TEST_PII_ENDPOINT')


@unittest.skipUnless(ENDPOINT, 'requires KEEL_TEST_PII_ENDPOINT; run via scripts/with_pii_sidecar.py')
class PiiHttpTests(unittest.TestCase):
    def post(self, body):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        request = urllib.request.Request(ENDPOINT, raw, {'Content-Type': 'application/json'})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            response = opener.open(request, timeout=2)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    # Break: passthrough or homemade fake recognition cannot replace real email/phone through HTTP.
    def test_presidio_detects_email_phone(self):
        status, result = self.post({'items': [
            {'id': '0', 'text': 'Email audit@example.com or call +1 202-555-0143.'},
            {'id': '1', 'text': 'Deployment completed.'}]})
        self.assertEqual(status, 200)
        self.assertEqual(result, {'items': [
            {'id': '0', 'text': 'Email [REDACTED] or call [REDACTED].'},
            {'id': '1', 'text': 'Deployment completed.'}]})

    # Break: caller-controlled operators/entities or malformed input can echo PII or bypass limits.
    def test_invalid_and_oversize_requests_never_echo_input(self):
        bad = [
            b'{"audit@example.com":',
            {'items': [{'id': '0', 'text': 'audit@example.com', 'operator': 'keep'}]},
            {'items': [{'id': '0', 'text': 'audit@example.com'}], 'language': 'any'},
            {'items': [{'id': '0', 'text': 'a' * 4097}]},
            {'items': [{'id': '0', 'text': 'audit@example.com'}] * 129},
            {'items': [{'id': '0', 'text': 'a'}, {'id': '0', 'text': 'b'}]},
            b'x' * 65537,
        ]
        for body in bad:
            with self.subTest(case=bad.index(body)):
                status, result = self.post(body)
                self.assertIn(status, (400, 413))
                self.assertEqual(result, {'error': 'INVALID_PII_REQUEST'})


class PiiAsgiTests(unittest.IsolatedAsyncioTestCase):
    async def request(self, body, more=False):
        output = []
        messages = iter([{'type': 'http.request', 'body': body, 'more_body': more},
                         {'type': 'http.disconnect'}])
        async def receive():
            return next(messages)
        async def send(message):
            output.append(message)
        await service.app({'type': 'http', 'method': 'POST', 'path': '/redact',
                   'headers': [(b'content-type', b'application/json')]}, receive, send)
        return output

    # Break: JSON parser/validation failure must not return raw input or framework validation echoes.
    async def test_malformed_body_has_fixed_safe_error(self):
        result = await self.request(b'{"audit@example.com":')
        self.assertEqual(result[0]['status'], 400)
        self.assertEqual(json.loads(result[1]['body']), {'error': 'INVALID_PII_REQUEST'})

    # Break: disconnected uploads must terminate rather than analyzing a partial body.
    async def test_disconnected_body_has_fixed_safe_error(self):
        result = await self.request(b'{"items":', more=True)
        self.assertEqual(result[0]['status'], 400)
        self.assertEqual(json.loads(result[1]['body']), {'error': 'INVALID_PII_REQUEST'})


    # Break: actual provider errors must produce fixed failures without request text in stderr/logs/cause.
    async def test_provider_faults_have_safe_responses_and_no_raw_logs(self):
        raw = json.dumps({'items': [{'id': '0', 'text': 'audit@example.com'}]}).encode()
        for owner, method in [(service.analyzer, 'analyze'), (service.anonymizer, 'anonymize')]:
            with self.subTest(boundary=method):
                stream = io.StringIO()
                handler = logging.StreamHandler(stream)
                logging.getLogger().addHandler(handler)
                try:
                    with patch.object(owner, method, side_effect=RuntimeError('audit@example.com private-token')):
                        with contextlib.redirect_stderr(stream), contextlib.redirect_stdout(stream):
                            result = await self.request(raw)
                    self.assertEqual(result[0]['status'], 503)
                    self.assertEqual(json.loads(result[1]['body']), {'error': 'PII_UNAVAILABLE'})
                    self.assertEqual(stream.getvalue(), '')
                finally:
                    logging.getLogger().removeHandler(handler)

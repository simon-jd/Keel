"""Bounded ASGI endpoint using real Presidio, limited to English email/US phone.

No NER checkpoint is loaded. The trusted operator binds this to loopback and
supplies process limits; request bodies/results/exceptions are never logged.
"""
import os

# These supported settings must precede Presidio/tldextract/numpy imports.
os.environ['TLDEXTRACT_PUBLIC_SUFFIX_LIST_URLS'] = ''
os.environ['TLDEXTRACT_CACHE'] = ''
os.environ['PRESIDIO_DEVICE'] = 'cpu'
for variable in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'BLIS_NUM_THREADS'):
    os.environ[variable] = '1'

import asyncio
import json
from presidio_analyzer import AnalyzerEngine, RecognizerRegistry
from presidio_analyzer.nlp_engine import NoOpNlpEngine
from presidio_analyzer.predefined_recognizers import EmailRecognizer, PhoneRecognizer
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

ENTITIES = ('EMAIL_ADDRESS', 'PHONE_NUMBER')
analyzer = AnalyzerEngine(
    registry=RecognizerRegistry(recognizers=[EmailRecognizer(), PhoneRecognizer(supported_regions=['US'])],
                                supported_languages=['en']),
    nlp_engine=NoOpNlpEngine(models=[{'lang_code': 'en', 'model_name': ''}]),
    supported_languages=['en'], log_decision_process=False)
anonymizer = AnonymizerEngine()
operators = {kind: OperatorConfig('replace', {'new_value': '[REDACTED]'}) for kind in ENTITIES}

MAX_BODY_BYTES = 65_536
MAX_TEXT_BYTES = 49_152
MAX_ITEMS = 128
MAX_TEXT_CHARS = 4096


class InvalidRequest(Exception):
    pass


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InvalidRequest()
        result[key] = value
    return result


def parse_items(body):
    value = json.loads(body.decode('utf-8'), object_pairs_hook=unique_object,
                       parse_constant=lambda _: (_ for _ in ()).throw(InvalidRequest()))
    if type(value) is not dict or set(value) != {'items'}:
        raise InvalidRequest()
    items = value['items']
    if type(items) is not list or not 1 <= len(items) <= MAX_ITEMS:
        raise InvalidRequest()
    total = 0
    for index, item in enumerate(items):
        if type(item) is not dict or set(item) != {'id', 'text'}:
            raise InvalidRequest()
        if item['id'] != str(index) or type(item['text']) is not str:
            raise InvalidRequest()
        text = item['text']
        if not 1 <= len(text) <= MAX_TEXT_CHARS:
            raise InvalidRequest()
        total += len(text.encode('utf-8'))
    if total > MAX_TEXT_BYTES:
        raise InvalidRequest()
    return items


async def respond(send, status, value):
    body = json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode()
    await send({'type': 'http.response.start', 'status': status,
                'headers': [(b'content-type', b'application/json'),
                            (b'content-length', str(len(body)).encode()),
                            (b'cache-control', b'no-store')]})
    await send({'type': 'http.response.body', 'body': body})


async def app(scope, receive, send):
    if scope['type'] == 'lifespan':
        while True:
            message = await receive()
            if message['type'] == 'lifespan.startup':
                await send({'type': 'lifespan.startup.complete'})
            elif message['type'] == 'lifespan.shutdown':
                await send({'type': 'lifespan.shutdown.complete'})
                return
    if scope['type'] != 'http':
        return
    if scope['method'] == 'GET' and scope['path'] == '/health':
        await respond(send, 200, {'status': 'ready'})
        return
    if scope['method'] != 'POST' or scope['path'] != '/redact':
        await respond(send, 404, {'error': 'INVALID_PII_REQUEST'})
        return
    status = 400
    try:
        headers = dict(scope.get('headers', []))
        if headers.get(b'content-type', b'').split(b';')[0].strip().lower() != b'application/json':
            raise InvalidRequest()
        if int(headers.get(b'content-length', b'0')) > MAX_BODY_BYTES:
            status = 413
            raise InvalidRequest()
        body = bytearray()
        async with asyncio.timeout(.2):
            while True:
                message = await receive()
                if message['type'] != 'http.request':
                    raise InvalidRequest()
                body.extend(message.get('body', b''))
                if len(body) > MAX_BODY_BYTES:
                    status = 413
                    raise InvalidRequest()
                if not message.get('more_body'):
                    break
        items = parse_items(body)
    except (ValueError, UnicodeError, InvalidRequest, TimeoutError, OverflowError, RecursionError):
        await respond(send, status, {'error': 'INVALID_PII_REQUEST'})
        return
    try:
        results = []
        for item in items:
            hits = analyzer.analyze(text=item['text'], language='en', entities=list(ENTITIES))
            result = anonymizer.anonymize(text=item['text'], analyzer_results=hits, operators=operators)
            results.append({'id': item['id'], 'text': result.text})
    except Exception:
        # Provider exception strings/cause/traceback may contain original text.
        await respond(send, 503, {'error': 'PII_UNAVAILABLE'})
        return
    await respond(send, 200, {'items': results})

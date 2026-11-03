"""Only model transport for benchmark agents, simulators and evaluators."""
import json
import uuid
from urllib.parse import urlsplit
from urllib.error import HTTPError
from urllib.request import Request, build_opener, HTTPRedirectHandler

class AdmissionStop(RuntimeError):
    """No further benchmark work after a commercial admission boundary rejects."""

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('KEEL_REDIRECT_DENIED')

class KeelClient:
    def __init__(self, endpoint, token, *, model='local', temperature=0.0, max_tokens=2048, seed=0, max_calls=1000):
        url = urlsplit(endpoint)
        if url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost', '::1') or url.path not in ('', '/') or url.query or url.fragment or url.username or not token:
            raise ValueError('KEEL_INVALID_CONFIGURATION')
        self.endpoint, self.token = endpoint.rstrip('/'), token
        self.model, self.temperature, self.max_tokens = model, temperature, max_tokens
        if type(max_calls)!=int or not 0<=max_calls<=1000:raise ValueError('INVALID_DISPATCH_LIMIT')
        self.max_calls=max_calls
        self.seed = seed
        self.run_id, self.calls, self.records = str(uuid.uuid4()), 0, []
        self.opener = build_opener(NoRedirect)
        self.exchanges, self.exchange_bytes = [], 0

    def step(self, messages, tools=None):
        if self.calls>=self.max_calls:
            from artifacts import ArtifactLimit
            raise ArtifactLimit('BATCH_REQUEST_LIMIT')
        payload = dict(seed=self.seed,messages=messages, tools=tools or [], model=self.model, temperature=self.temperature,
                       maxTokens=self.max_tokens, run_id=self.run_id, call_id=f'{self.run_id}:{self.calls+1}')
        encoded=json.dumps(payload).encode()
        if self.exchange_bytes+len(encoded)+2000000>32000000:
            from artifacts import ArtifactLimit
            raise ArtifactLimit('EXCHANGE_MEMORY_LIMIT')
        self.calls+=1
        exchange={'request':payload};self.exchanges.append(exchange)
        self.exchange_bytes+=len(encoded)
        request = Request(self.endpoint + '/v1/agent/step', encoded,
                          {'Authorization': f'Bearer {self.token}', 'Content-Type': 'application/json'}, method='POST')
        try:
            with self.opener.open(request, timeout=180) as response:
                raw = response.read(2_000_001)
                if len(raw) > 2_000_000: raise RuntimeError('KEEL_RESPONSE_LIMIT')
                result = json.loads(raw)
        except HTTPError as error:
            admission=None
            try:
                raw=error.read(2_000_001)
                result=json.loads(raw) if len(raw)<=2_000_000 else {}
                if isinstance(result,dict):
                    if result.get('error') in {'BUDGET_EXHAUSTED','BUDGET_DENIED','MODEL_INPUT_REJECTED'}:admission=result['error']
                    self.records.append({key:result.get(key) for key in ('accounting','call_id','latency_ms','prompt_hash')})
                    exchange['response']={key:result.get(key) for key in ('error','accounting','call_id','latency_ms','prompt_hash','usage','invalidToolCalls')}
            except Exception:pass
            if admission:raise AdmissionStop(admission) from None
            raise RuntimeError('KEEL_REQUEST_FAILED') from None
        except Exception:
            # Never include provider bodies, policies, arguments, or credentials in errors.
            raise RuntimeError('KEEL_REQUEST_FAILED') from None
        if not isinstance(result, dict) or not isinstance(result.get('action'), dict):
            raise RuntimeError('KEEL_INVALID_RESPONSE')
        exchange['response']={key:result.get(key) for key in ('action','invalidToolCalls','usage','accounting','call_id','run_id','latency_ms','prompt_hash')}
        self.exchange_bytes+=len(raw)
        self.records.append({key: result.get(key) for key in ('accounting', 'call_id', 'latency_ms', 'prompt_hash')})
        return result

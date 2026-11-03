#!/usr/bin/env python3
"""Fail-closed Keel commercial-API reservations. No cloud provisioning or API clients."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_CEILING, localcontext
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import urlparse
import uuid

DEFAULT_LEDGER = Path(__file__).resolve().parents[1] / 'docs/azure-spend.json'
LIMIT = Decimal('9.00')
SOURCES = {'openai': {'openai.com', 'platform.openai.com', 'developers.openai.com'},
           'anthropic': {'anthropic.com', 'www.anthropic.com', 'docs.anthropic.com', 'platform.claude.com'},
           'azure': {'azure.microsoft.com', 'prices.azure.com'}}


def money(value):
    if isinstance(value, bool) or value is None:
        raise ValueError('Missing or invalid price/amount.')
    try:
        amount = Decimal(str(value))
    except InvalidOperation as error:
        raise ValueError('Invalid decimal amount.') from error
    if not amount.is_finite() or amount < 0:
        raise ValueError('Amount must be finite and nonnegative.')
    return amount


def utc(value):
    if not isinstance(value, str) or not value.endswith('Z'):
        raise ValueError('Timestamp must be UTC ending Z.')
    return datetime.fromisoformat(value[:-1] + '+00:00')


def count(value):
    if isinstance(value, bool) or not str(value).isdigit():
        raise ValueError('Token/request bounds must be nonnegative integers.')
    return int(value)


def quote_estimate(quote, max_input_tokens, max_output_tokens, requests, *, allow_expired=False):
    now = datetime.now(timezone.utc)
    source = urlparse(quote.get('source', ''))
    if (quote.get('kind') != 'commercial_api' or quote.get('currency') != 'USD'
            or quote.get('unit') != 'token' or quote.get('provider') not in SOURCES
            or source.scheme != 'https' or source.hostname not in SOURCES[quote['provider']]
            or source.username or source.password
            or any(not isinstance(quote.get(key), str) or not quote[key].strip()
                   for key in ('model', 'sku', 'region'))):
        raise ValueError('Only identified, officially quoted USD/token commercial APIs are allowed.')
    if utc(quote.get('quoted_at')) > now or (not allow_expired and utc(quote.get('valid_until')) <= now):
        raise ValueError('Quote is future-dated or expired.')
    request_count = count(requests)
    if request_count < 1:
        raise ValueError('At least one bounded request is required.')
    with localcontext() as context:
        context.prec = 80
        # All operands are nonnegative. Round every intermediate operation upward,
        # so arbitrarily small positive terms cannot disappear before quantization.
        context.rounding = ROUND_CEILING
        total = request_count * (count(max_input_tokens) * money(quote.get('input_usd_per_unit'))
                                 + count(max_output_tokens) * money(quote.get('output_usd_per_unit')))
        # Round upward to a nano-dollar: decimal precision must never erase positive exposure.
        total = total.quantize(Decimal('0.000000001'), rounding=ROUND_CEILING)
    if total <= 0:
        raise ValueError('Paid execution requires a positive bounded estimate.')
    return total


def validate_ledger(data):
    if (data.get('schema_version') != 1 or data.get('project') != 'keel'
            or data.get('currency') != 'USD' or money(data.get('project_limit_usd')) != Decimal('10')
            or money(data.get('gate_usd')) != LIMIT or not isinstance(data.get('reservations'), list)):
        raise ValueError('Ledger identity/limits malformed; refusing execution.')
    seen = set()
    for item in data['reservations']:
        if (not isinstance(item, dict) or item.get('status') not in {'reserved', 'running', 'failed', 'completed'}
                or not isinstance(item.get('id'), str) or item['id'] in seen):
            raise ValueError('Malformed or duplicate ledger reservation.')
        seen.add(item['id'])
        money(item.get('estimate_usd'))
        if item.get('phase') == 'task9-agent-judge-azure-mini-v1' or 'profile_sha256' in item:
            from judge_budget import validate_item
            validate_item(item)
        elif item.get('phase') == 'task8-bfcl-first10-seed0-azure-mini-v1':
            # Retain and recompute the entire historical reservation in cumulative gates.
            expected = quote_estimate(item['quote'], COMMERCIAL_INPUT, COMMERCIAL_OUTPUT, COMMERCIAL_ATTEMPTS, allow_expired=True)
            if expected != money(item['estimate_usd']):
                raise ValueError('Historical commercial reserve was altered.')
    with localcontext() as context:
        context.prec = 80
        context.rounding = ROUND_CEILING
        total = sum((money(item['estimate_usd']) for item in data['reservations']), Decimal(0))
    if total > LIMIT:
        raise ValueError('Ledger already exceeds gate; refusing execution.')
    return total


def atomic_write(path, data):
    fd, temporary = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(data, handle, indent=2, allow_nan=False)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def locked_ledger(path):
    path = Path(path).absolute()
    if path.is_symlink():
        raise ValueError('Ledger symlinks are not accepted.')
    with os.fdopen(os.open(str(path) + '.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield path


def reserve(path, quote, max_input_tokens, max_output_tokens, requests=1):
    """Atomic reservation API for future paid-call adapters; never refunds unknown spend."""
    estimate = quote_estimate(quote, max_input_tokens, max_output_tokens, requests)
    with locked_ledger(path) as ledger_path:
        ledger = json.loads(ledger_path.read_text())
        total = validate_ledger(ledger)
        if total + estimate > LIMIT:
            raise ValueError('Reservation rejected: cumulative estimate would exceed 9.00 USD.')
        reservation = {'id': str(uuid.uuid4()), 'status': 'reserved', 'estimate_usd': str(estimate),
                       'created_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                       'quote': quote, 'max_input_tokens': count(max_input_tokens),
                       'max_output_tokens': count(max_output_tokens), 'requests': count(requests)}
        ledger['reservations'].append(reservation)
        atomic_write(ledger_path, ledger)
        return {'reservation_id': reservation['id'], 'estimate_usd': str(estimate), 'total_usd': str(total + estimate)}


def claim(path, reservation_id):
    """Single-use, locked claim. All paid paths must call before invoking a provider."""
    with locked_ledger(path) as ledger_path:
        ledger = json.loads(ledger_path.read_text())
        validate_ledger(ledger)
        item = next((r for r in ledger['reservations'] if r['id'] == reservation_id), None)
        if item is not None and item.get('phase') == 'task9-agent-judge-azure-mini-v1':
            raise ValueError('Task9 requires its distinct commercial claim.')
        if item is None or item['status'] != 'reserved':
            raise ValueError('Missing or already consumed reservation; paid execution denied.')
        estimate = quote_estimate(item['quote'], item['max_input_tokens'], item['max_output_tokens'], item['requests'])
        if estimate != money(item['estimate_usd']):
            raise ValueError('Reservation quote/estimate mismatch.')
        item['status'] = 'running'
        atomic_write(ledger_path, ledger)
        return dict(item)


def finish(path, reservation_id, success):
    with locked_ledger(path) as ledger_path:
        ledger = json.loads(ledger_path.read_text())
        validate_ledger(ledger)
        item = next((r for r in ledger['reservations'] if r['id'] == reservation_id), None)
        if item is not None and item.get('phase') == 'task9-agent-judge-azure-mini-v1':
            raise ValueError('Task9 requires its distinct settlement/abort; generic finish denied.')
        if item is None or item['status'] != 'running':
            raise ValueError('Only a running reservation can finish.')
        item['status'] = 'completed' if success else 'failed'
        item['finished_at'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        atomic_write(ledger_path, ledger)


# Fixed commercial admission policy: official maximum context, not a byte/token heuristic.
COMMERCIAL_PHASE = 'task8-bfcl-first10-seed0-azure-mini-v1'
COMMERCIAL_INPUT = 1047576
COMMERCIAL_OUTPUT = 2048
COMMERCIAL_ATTEMPTS = 10
COMMERCIAL_BYTES = 32768


def commercial_binding(binding, quote, *, regions=('eastus',)):
    import re
    if (set(binding) != {'endpoint', 'deployment', 'model', 'version', 'region', 'sku', 'quote_id', 'request_hashes'}
            or not re.fullmatch(r'https://[a-z0-9][a-z0-9-]{1,62}\.openai\.azure\.com/openai/v1', binding['endpoint'])
            or not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', binding['deployment'])
            or binding['model'] != 'gpt-4.1-mini' or binding['version'] != '2025-04-14'
            or binding['region'] not in regions or binding['sku'] != 'GlobalStandard'
            or quote.get('provider') != 'azure'
            or any(binding[key] != quote.get(key) for key in ('model', 'version', 'region', 'sku', 'quote_id'))
            or not isinstance(binding['quote_id'], str) or not binding['quote_id']
            or not isinstance(binding['request_hashes'], list) or not 1 <= len(binding['request_hashes']) <= 10
            or len(set(binding['request_hashes'])) != len(binding['request_hashes'])
            or any(not isinstance(value, str) or not re.fullmatch('[0-9a-f]{64}', value) for value in binding['request_hashes'])):
        raise ValueError('Invalid fixed commercial binding.')
    return dict(binding)


def reserve_commercial(path, quote, binding):
    """Operator-only reservation; fixture quotes do not authorize a real invocation."""
    binding = commercial_binding(binding, quote)
    estimate = quote_estimate(quote, COMMERCIAL_INPUT, COMMERCIAL_OUTPUT, COMMERCIAL_ATTEMPTS)
    with locked_ledger(path) as ledger_path:
        ledger = json.loads(ledger_path.read_text())
        total = validate_ledger(ledger)
        if any(prior.get('phase') == COMMERCIAL_PHASE for prior in ledger['reservations']):
            raise ValueError('This fixed commercial phase already has a reservation.')
        if total + estimate > LIMIT:
            raise ValueError('Commercial reservation exceeds cumulative gate.')
        item = dict(id=str(uuid.uuid4()), phase=COMMERCIAL_PHASE, status='reserved', estimate_usd=str(estimate),
                    created_at=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                    quote=quote, max_input_tokens=COMMERCIAL_INPUT, max_output_tokens=COMMERCIAL_OUTPUT,
                    requests=COMMERCIAL_ATTEMPTS, max_body_bytes=COMMERCIAL_BYTES, n=1, binding=binding,
                    attempts=[], known_cost_usd='0', cost_status='known')
        ledger['reservations'].append(item)
        atomic_write(ledger_path, ledger)
        return dict(reservation_id=item['id'], estimate_usd=str(estimate), total_usd=str(total + estimate))


def commercial_item(ledger, reservation_id, binding=None, claim_token=None, *, require_fresh=True):
    import hashlib
    import hmac
    validate_ledger(ledger)
    item = next((r for r in ledger['reservations'] if r['id'] == reservation_id), None)
    if item is None or item.get('phase') != COMMERCIAL_PHASE or 'binding' not in item:
        raise ValueError('Commercial reservation missing.')
    commercial_binding(item['binding'], item['quote'], regions=('eastus', 'westus'))
    validate_commercial_regional_history(item)
    if binding is not None and binding != item['binding']:
        raise ValueError('Commercial binding mismatch.')
    limits = {'max_input_tokens': COMMERCIAL_INPUT, 'max_output_tokens': COMMERCIAL_OUTPUT,
              'requests': COMMERCIAL_ATTEMPTS, 'max_body_bytes': COMMERCIAL_BYTES, 'n': 1}
    if (any(type(item.get(key)) is not int or item[key] != value for key, value in limits.items())
            or not isinstance(item.get('attempts'), list)
            or len(item['attempts']) > COMMERCIAL_ATTEMPTS
            or quote_estimate(item['quote'], COMMERCIAL_INPUT, COMMERCIAL_OUTPUT, COMMERCIAL_ATTEMPTS, allow_expired=not require_fresh) != money(item['estimate_usd'])):
        raise ValueError('Commercial bounds/quote mismatch.')
    validate_commercial_recovery_history(item)
    if claim_token is not None and (item['status'] != 'running' or not isinstance(claim_token, str)
            or not hmac.compare_digest(item.get('claim_sha256', ''), hashlib.sha256(claim_token.encode()).hexdigest())):
        raise ValueError('Commercial claim missing or mismatched.')
    return item


REGIONAL_REBIND_REASON = 'azure_subscription_region_policy_eastus_to_westus'


def validate_commercial_regional_pair(old_binding, old_quote, binding, quote):
    """The sole regional amendment changes no price, deployment or ordered request."""
    commercial_binding(old_binding, old_quote)
    commercial_binding(binding, quote, regions=('westus',))
    mutable = {'endpoint', 'region', 'quote_id'}
    if ({key: value for key, value in old_binding.items() if key not in mutable}
            != {key: value for key, value in binding.items() if key not in mutable}
            or any(money(old_quote[key]) != money(quote[key])
                   for key in ('input_usd_per_unit', 'output_usd_per_unit'))):
        raise ValueError('Regional amendment cannot change deployment, requests or prices.')
    estimates = []
    for value in (old_quote, quote):
        if utc(value['valid_until']) <= utc(value['quoted_at']):
            raise ValueError('Malformed commercial quote interval.')
        estimates.append(quote_estimate(value, COMMERCIAL_INPUT, COMMERCIAL_OUTPUT,
                                        COMMERCIAL_ATTEMPTS, allow_expired=True))
    if estimates[0] != estimates[1]:
        raise ValueError('Regional amendment cannot change reserved exposure.')


def validate_commercial_regional_history(item):
    """westus is operational only with the original eastus transition evidence."""
    if item['binding']['region'] == 'eastus':
        if 'regional_rebinds' in item:
            raise ValueError('Legacy eastus cannot have regional amendment history.')
        return
    history = item.get('regional_rebinds')
    if not isinstance(history, list) or len(history) != 1:
        raise ValueError('westus requires exactly one audited regional amendment.')
    audit = history[0]
    if (not isinstance(audit, dict) or set(audit) != {'from_binding', 'from_quote', 'rebound_at', 'reason'}
            or audit['reason'] != REGIONAL_REBIND_REASON
            or not utc(item['created_at']) <= utc(audit['rebound_at']) <= datetime.now(timezone.utc)):
        raise ValueError('Malformed regional amendment audit.')
    validate_commercial_regional_pair(audit['from_binding'], audit['from_quote'], item['binding'], item['quote'])


def require_commercial_unstarted(item):
    if (item['status'] != 'reserved' or item['attempts']
            or any(key in item for key in ('claim', 'claim_sha256', 'claim_token', 'claimed_at', 'finished_at'))
            or money(item.get('known_cost_usd')) != 0 or item.get('cost_status') != 'known'):
        raise ValueError('Commercial reservation was claimed, attempted or has unknown exposure.')


def rebind_commercial_unstarted(path, reservation_id, quote, binding):
    """Operator-only, one-time eastus->westus amendment; never creates/refunds a reserve."""
    with locked_ledger(path) as ledger_path:
        ledger = json.loads(ledger_path.read_text())
        item = commercial_item(ledger, reservation_id, require_fresh=False)
        require_commercial_unstarted(item)
        validate_commercial_regional_pair(item['binding'], item['quote'], binding, quote)
        estimate = quote_estimate(quote, COMMERCIAL_INPUT, COMMERCIAL_OUTPUT, COMMERCIAL_ATTEMPTS)
        if estimate != money(item['estimate_usd']):
            raise ValueError('Regional amendment estimate differs from existing reservation.')
        audit = dict(from_binding=item['binding'], from_quote=item['quote'],
                     rebound_at=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                     reason=REGIONAL_REBIND_REASON)
        item.update(binding=binding, quote=quote, regional_rebinds=[audit])
        validate_commercial_regional_history(item)
        total = validate_ledger(ledger)
        atomic_write(ledger_path, ledger)
        return dict(reservation_id=item['id'], estimate_usd=item['estimate_usd'], total_usd=str(total))


CLAIM_RECOVERY_REASON = 'pre_dispatch_manifest_docs_only_head_mismatch'


def require_commercial_undispatched_claim(item):
    import re
    digest = item.get('claim_sha256')
    if (item.get('phase') != COMMERCIAL_PHASE or not isinstance(item.get('binding'), dict)
            or item['binding'].get('region') != 'westus' or item.get('status') != 'running'
            or not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest)
            or item.get('attempts') != [] or money(item.get('known_cost_usd')) != 0
            or item.get('cost_status') != 'known'
            or any(key in item for key in ('claim', 'claim_token', 'claimed_at', 'finished_at',
                                           'claim_recoveries', 'claim_recovery_count', 'claim_recovery_sha256'))):
        raise ValueError('Only an audited westus zero-dispatch claim can recover once.')


def commercial_recovery_fingerprint(audit):
    import hashlib
    return hashlib.sha256(json.dumps(audit, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def validate_commercial_recovery_history(item):
    import re
    if not any(key in item for key in ('claim_recoveries', 'claim_recovery_count', 'claim_recovery_sha256')):
        return
    history = item.get('claim_recoveries')
    if (type(item.get('claim_recovery_count')) is not int or item['claim_recovery_count'] != 1
            or not isinstance(history, list) or len(history) != 1):
        raise ValueError('Malformed or repeated claim recovery history.')
    audit = history[0]
    if (not isinstance(audit, dict) or set(audit) != {'prior_state', 'recovered_at', 'reason'}
            or audit['reason'] != CLAIM_RECOVERY_REASON or not isinstance(audit['prior_state'], dict)):
        raise ValueError('Malformed claim recovery audit.')
    if item.get('claim_recovery_sha256') != commercial_recovery_fingerprint(audit):
        raise ValueError('Claim recovery audit fingerprint mismatch.')
    prior = audit['prior_state']
    require_commercial_undispatched_claim(prior)
    recovered = utc(audit['recovered_at'])
    if not (utc(item['created_at']) <= utc(item['regional_rebinds'][0]['rebound_at']) <= recovered
            <= datetime.now(timezone.utc) and utc(prior['quote']['quoted_at']) <= recovered
            < utc(prior['quote']['valid_until'])):
        raise ValueError('Malformed claim recovery timestamp or original quote.')
    mutable = {'status', 'claim_sha256', 'attempts', 'known_cost_usd', 'cost_status',
               'finished_at', 'claim_recoveries', 'claim_recovery_count', 'claim_recovery_sha256'}
    if ({key: value for key, value in item.items() if key not in mutable}
            != {key: value for key, value in prior.items() if key not in mutable}):
        raise ValueError('Claim recovery cannot alter original provenance or exposure.')
    if item['status'] == 'reserved':
        require_commercial_unstarted(item)
    else:
        digest = item.get('claim_sha256')
        if (not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest)
                or digest == prior['claim_sha256']
                or item.get('cost_status') not in {'known', 'unknown'}):
            raise ValueError('Recovered claim requires a new valid digest and accounting.')
        money(item.get('known_cost_usd'))
        if not item['attempts'] and (money(item['known_cost_usd']) != 0 or item['cost_status'] != 'known'):
            raise ValueError('Zero-attempt recovered claim has unexpected exposure.')
        if item['status'] in {'completed', 'failed'}:
            if not recovered <= utc(item.get('finished_at')) <= datetime.now(timezone.utc):
                raise ValueError('Malformed recovered finish state.')
        elif 'finished_at' in item:
            raise ValueError('Running recovered claim cannot have a finish state.')


def recover_commercial_undispatched(path, reservation_id):
    """One explicit operator recovery, never an automatic restart or consumed refund."""
    from copy import deepcopy
    with locked_ledger(path) as ledger_path:
        ledger = json.loads(ledger_path.read_text())
        item = commercial_item(ledger, reservation_id)
        require_commercial_undispatched_claim(item)
        audit = dict(prior_state=deepcopy(item),
                     recovered_at=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                     reason=CLAIM_RECOVERY_REASON)
        item.update(status='reserved', claim_recoveries=[audit], claim_recovery_count=1,
                    claim_recovery_sha256=commercial_recovery_fingerprint(audit))
        del item['claim_sha256']
        validate_commercial_recovery_history(item)
        total = validate_ledger(ledger)
        atomic_write(ledger_path, ledger)
        return dict(reservation_id=item['id'], estimate_usd=item['estimate_usd'], total_usd=str(total))


def claim_commercial(path, reservation_id, binding):
    import hashlib
    import secrets
    with locked_ledger(path) as ledger_path:
        ledger = json.loads(ledger_path.read_text())
        item = commercial_item(ledger, reservation_id, binding)
        require_commercial_unstarted(item)
        token = secrets.token_hex(32)
        item.update(status='running', claim_sha256=hashlib.sha256(token.encode()).hexdigest())
        validate_commercial_recovery_history(item)
        atomic_write(ledger_path, ledger)
        return dict(claim_token=token, input_per_million=str(money(item['quote']['input_usd_per_unit']) * 1000000),
                    output_per_million=str(money(item['quote']['output_usd_per_unit']) * 1000000))


def consume_commercial(path, reservation_id, claim_token, binding, request_hash):
    with locked_ledger(path) as ledger_path:
        ledger = json.loads(ledger_path.read_text())
        item = commercial_item(ledger, reservation_id, binding, claim_token)
        if request_hash not in item['binding']['request_hashes']:
            raise ValueError('Unapproved synthetic request.')
        if len(item['attempts']) >= COMMERCIAL_ATTEMPTS:
            raise ValueError('budget_exhausted')
        number = len(item['attempts']) + 1
        # Persist unknown BEFORE fetch: crashes/cancellation cannot restore exposure.
        item['attempts'].append(dict(attempt=number, request_hash=request_hash, cost_status='unknown', settled=False,
                                    consumed_at=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')))
        item['cost_status'] = 'unknown'
        atomic_write(ledger_path, ledger)
        return dict(attempt=number)


def settle_commercial(path, reservation_id, claim_token, attempt, usage):
    with locked_ledger(path) as ledger_path:
        ledger = json.loads(ledger_path.read_text())
        item = commercial_item(ledger, reservation_id, claim_token=claim_token, require_fresh=False)
        if type(attempt) is not int or not 1 <= attempt <= len(item['attempts']):
            raise ValueError('Unknown commercial attempt.')
        entry = item['attempts'][attempt - 1]
        if entry['settled']:
            raise ValueError('Attempt settlement is single-use.')
        entry['settled'] = True
        if usage is not None:
            if set(usage) != {'input', 'output'} or any(type(usage[k]) is not int or usage[k] < 0 for k in usage):
                raise ValueError('Invalid commercial usage.')
            with localcontext() as context:
                context.prec = 80
                context.rounding = ROUND_CEILING
                cost = money(item['quote']['input_usd_per_unit']) * usage['input'] + money(item['quote']['output_usd_per_unit']) * usage['output']
                item['known_cost_usd'] = str(money(item['known_cost_usd']) + cost)
            entry.update(cost_status='known', usage=usage, cost_usd=str(cost))
        item['cost_status'] = 'unknown' if any(a['cost_status'] == 'unknown' for a in item['attempts']) else 'known'
        atomic_write(ledger_path, ledger)
        return dict(known_cost_usd=item['known_cost_usd'], cost_status=item['cost_status'])


def commercial_rpc(path, *, judge=False):
    """Private stdin/stdout protocol; never receives prompts, provider keys or bodies."""
    try:
        limit = 262144 if judge else 16384
        raw = sys.stdin.read(limit + 1)
        if len(raw) > limit:
            raise ValueError('RPC limit.')
        data = json.loads(raw)
        action = data.pop('action')
        functions = {'claim': claim_commercial, 'consume': consume_commercial, 'settle': settle_commercial}
        if judge:
            import judge_budget
            functions = {'claim': judge_budget.claim, 'consume': judge_budget.consume, 'settle': judge_budget.settle}
        result = functions[action](path, **data)
        print(json.dumps(result))
        return 0
    except Exception as error:
        # Do not echo any stdin, file paths or exception content.
        print(json.dumps({'error': 'budget_exhausted' if str(error) == 'budget_exhausted' else 'budget_denied'}))
        return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ledger', type=Path, default=DEFAULT_LEDGER)
    subs = parser.add_subparsers(dest='action', required=True)
    subs.add_parser('init')
    subs.add_parser('status')
    subs.add_parser('commercial-rpc')
    subs.add_parser('judge-commercial-rpc')
    abort = subs.add_parser('abort-judge-commercial')
    abort.add_argument('--reservation', required=True)
    judge = subs.add_parser('reserve-judge-commercial')
    judge.add_argument('--quote', type=Path, required=True)
    judge.add_argument('--binding', type=Path, required=True)
    commercial = subs.add_parser('reserve-commercial')
    commercial.add_argument('--quote', type=Path, required=True)
    commercial.add_argument('--binding', type=Path, required=True)
    regional = subs.add_parser('rebind-commercial-unstarted')
    regional.add_argument('--reservation', required=True)
    regional.add_argument('--quote', type=Path, required=True)
    regional.add_argument('--binding', type=Path, required=True)
    recovery = subs.add_parser('recover-commercial-undispatched')
    recovery.add_argument('--reservation', required=True)
    reservation = subs.add_parser('reserve')
    reservation.add_argument('--quote', type=Path, required=True)
    reservation.add_argument('--max-input-tokens', required=True)
    reservation.add_argument('--max-output-tokens', required=True)
    reservation.add_argument('--requests', default='1')
    run = subs.add_parser('exec')
    run.add_argument('--reservation', required=True)
    run.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    try:
        if args.action in ('commercial-rpc', 'judge-commercial-rpc'):
            return commercial_rpc(args.ledger, judge=args.action == 'judge-commercial-rpc')
        if args.action == 'abort-judge-commercial':
            import judge_budget
            result = judge_budget.abort(args.ledger, args.reservation)
        elif args.action == 'reserve-judge-commercial':
            import judge_budget
            result = judge_budget.reserve(args.ledger, json.loads(args.quote.read_text()), json.loads(args.binding.read_text()))
        elif args.action == 'reserve-commercial':
            result = reserve_commercial(args.ledger, json.loads(args.quote.read_text()), json.loads(args.binding.read_text()))
        elif args.action == 'rebind-commercial-unstarted':
            result = rebind_commercial_unstarted(args.ledger, args.reservation, json.loads(args.quote.read_text()),
                                                 json.loads(args.binding.read_text()))
        elif args.action == 'recover-commercial-undispatched':
            result = recover_commercial_undispatched(args.ledger, args.reservation)
        elif args.action == 'reserve':
            result = reserve(args.ledger, json.loads(args.quote.read_text()), args.max_input_tokens,
                             args.max_output_tokens, args.requests)
        elif args.action == 'exec':
            command = args.command[1:] if args.command[:1] == ['--'] else args.command
            if not command:
                raise ValueError('Command required.')
            claim(args.ledger, args.reservation)
            try:
                code = subprocess.run(command, env=dict(os.environ, KEEL_BUDGET_RESERVATION_ID=args.reservation)).returncode
            except OSError:
                finish(args.ledger, args.reservation, False)
                raise
            finish(args.ledger, args.reservation, code == 0)
            return code if code >= 0 else 128 - code
        else:
            with locked_ledger(args.ledger) as path:
                if args.action == 'init' and not path.exists():
                    atomic_write(path, {'schema_version': 1, 'project': 'keel', 'currency': 'USD',
                                        'project_limit_usd': '10.00', 'gate_usd': '9.00', 'reservations': []})
                ledger = json.loads(path.read_text())
                result = {'project': 'keel', 'total_usd': str(validate_ledger(ledger)),
                          'reservations': len(ledger['reservations'])}
        print(json.dumps(result))
        return 0
    except (ValueError, TypeError, KeyError, OSError) as error:
        print(f'Budget denied: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

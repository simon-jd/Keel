#!/usr/bin/env python3
"""Task 4: local Langfuse ingestion of real agent-run spans, end to end.

One process owns the whole experiment so the throwaway stack secrets live only in
memory (no .env or credential file): compose up -> GPU batch of real runAgent runs
(scripts/gpu_run.py + local_batch.py --langfuse) -> read back from Langfuse -> compose down -v.

  python3 scripts/langfuse_ingest.py run OUT [--runs N]   full experiment, evidence into OUT
  python3 scripts/langfuse_ingest.py explore OUT          stack up, dump storage schema, down
  python3 scripts/langfuse_ingest.py down                 remove this project's stack and volumes
"""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / 'infra/docker-compose.yml'
SERVICES = ['postgres', 'langfuse', 'langfuse-worker', 'collector']
LANGFUSE = 'http://127.0.0.1:13000'
PROJECT_ID = 'keel-local-ingest'
CLICKHOUSE = 'keel-clickhouse-1'
POSTGRES = 'keel-postgres-1'
# Stack mem_limits (resource_check.py compose) + this batch cap + headroom for the PII sidecar and
# inspection processes must stay under the 16 GB share. Recorded Qwen3-8B-AWQ vLLM batch peak: 5.37 GB
# (security rerun 2026-10-28); pilot 2026-10-29 measured 0.51 GB of sidecar + inspection processes.
BATCH_LIMIT = 6_400_000_000
HEADROOM = 1_000_000_000
# Qwen2.5-0.5B made no tool calls in the pilot (1 model call, 0 tool calls per run).
MODEL = 'qwen3-8b-awq'


def percentile(values, q):
    """Nearest-rank percentile; None for no data."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, -(-q * len(ordered) // 100) - 1)]


def distribution(values):
    return {'n': len(values), 'p50': percentile(values, 50), 'p95': percentile(values, 95),
            'max': max(values) if values else None}


def summarize(sent, stored, runs):
    """sent: spans the SDK handed to OTLP (post-PII, post-projection); stored: spanId -> Langfuse row facts."""
    sent_ids = {s['spanId'] for s in sent}
    missing = sorted(s['spanId'] for s in sent if s['spanId'] not in stored)
    found = [s for s in sent if s['spanId'] in stored]
    run_cost = []
    for run in runs:
        mine = [s for s in sent if s['attributes'].get('keel.run_id') == run['runId']]
        langfuse = sum(stored[s['spanId']]['cost'] or 0 for s in mine if s['spanId'] in stored)
        sent_usd = sum(s['attributes'].get('keel.cost_usd', 0) for s in mine)
        run_cost.append({'runId': run['runId'], 'runtime_usd': run['knownUsd'], 'sent_usd': round(sent_usd, 12),
                         'langfuse_usd': round(langfuse, 12),
                         'match': abs(run['knownUsd'] - sent_usd) < 1e-12 and abs(sent_usd - langfuse) < 1e-12})
    return {
        'spans': {'sent': len(sent), 'acknowledged': sum(1 for s in sent if s['ok']), 'stored': len(found),
                  'missing': len(missing), 'stored_not_sent': len(set(stored) - sent_ids), 'missing_ids': missing},
        'latency_ms': {'from_span_end': distribution([stored[s['spanId']]['storedMs'] - s['endMs'] for s in found]),
                       'from_export_ack': distribution([stored[s['spanId']]['storedMs'] - s['ackMs'] for s in found])},
        'run_cost': run_cost,
    }


def scan_for_canaries(blobs, canaries):
    """blobs: name -> bytes of everything read back from the stack. Returns name -> raw canaries found."""
    hits = {}
    for name, data in blobs.items():
        found = [c for c in canaries if c.encode() in data]
        if found:
            hits[name] = found
    return hits


def stack_environment():
    """Fresh random values per experiment; never written to disk."""
    token = lambda: secrets.token_hex(24)
    public, secret = f'pk-lf-{secrets.token_hex(16)}', f'sk-lf-{secrets.token_hex(16)}'
    values = {
        'KEEL_POSTGRES_PASSWORD': token(), 'LANGFUSE_POSTGRES_PASSWORD': token(), 'LANGFUSE_SALT': token(),
        'LANGFUSE_ENCRYPTION_KEY': secrets.token_hex(32), 'LANGFUSE_NEXTAUTH_SECRET': token(),
        'CLICKHOUSE_PASSWORD': token(), 'REDIS_PASSWORD': token(), 'MINIO_ROOT_USER': 'keel' + secrets.token_hex(4),
        'MINIO_ROOT_PASSWORD': token(),
        'LANGFUSE_INIT_ORG_ID': 'keel-local', 'LANGFUSE_INIT_ORG_NAME': 'keel-local',
        'LANGFUSE_INIT_PROJECT_ID': PROJECT_ID, 'LANGFUSE_INIT_PROJECT_NAME': PROJECT_ID,
        'LANGFUSE_INIT_PROJECT_PUBLIC_KEY': public, 'LANGFUSE_INIT_PROJECT_SECRET_KEY': secret,
        'LANGFUSE_OTLP_AUTH_BASE64': base64.b64encode(f'{public}:{secret}'.encode()).decode(),
        'OTEL_COLLECTOR_CONFIG': './otel-collector.langfuse.yaml',
    }
    return values


def placeholder_environment():
    """`compose down` still interpolates the file; values are irrelevant for removal."""
    return {name: 'unused' for name in stack_environment()} | {'LANGFUSE_ENCRYPTION_KEY': '0' * 64,
                                                               'OTEL_COLLECTOR_CONFIG': './otel-collector.langfuse.yaml'}


def compose(env, *args, check=True, capture=False):
    return subprocess.run(['docker', 'compose', '--file', str(COMPOSE), *args], env={**os.environ, **env},
                          check=check, text=True, capture_output=capture)


def wait_healthy(timeout=300):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(LANGFUSE + '/api/public/health', timeout=2) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        time.sleep(2)
    raise RuntimeError('LANGFUSE_NOT_HEALTHY')


def clickhouse(query):
    # The container already carries CLICKHOUSE_PASSWORD; nothing secret on the command line.
    result = subprocess.run(['docker', 'exec', CLICKHOUSE, 'clickhouse-client', '--user', 'langfuse', '--format', 'JSONEachRow', '-q', query],
                            check=True, text=True, capture_output=True)
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


def up(env):
    subprocess.run([sys.executable, str(ROOT / 'scripts/resource_check.py'), 'compose'], check=True, stdout=subprocess.DEVNULL)
    compose(env, 'up', '-d', '--wait', *SERVICES)
    wait_healthy()


def down():
    compose(placeholder_environment(), 'down', '--volumes', '--remove-orphans', check=False)


def explore(out):
    out.mkdir(parents=True, exist_ok=True)
    env = stack_environment()
    try:
        up(env)
        tables = clickhouse("SELECT name FROM system.tables WHERE database='default' ORDER BY name")
        columns = clickhouse("SELECT table, name, type FROM system.columns WHERE database='default' AND table IN ('traces','observations','events_core','events_full') ORDER BY table, position")
        api = {path: api_get(env, path)[0] for path in ['/api/public/traces', '/api/public/observations', '/api/public/v2/observations',
                                                        '/api/public/v2/traces', '/api/public/projects']}
        stats = subprocess.run(['docker', 'stats', '--no-stream', '--format', '{{json .}}'], check=True, text=True, capture_output=True).stdout
        (out / 'explore.json').write_text(json.dumps({'tables': tables, 'columns': columns, 'api': api,
            'stats': [json.loads(l) for l in stats.splitlines() if '"keel-' in l]}, indent=1))
    finally:
        down()


def machine_load():
    return {'nproc': os.cpu_count(), 'uptime': subprocess.run(['uptime'], text=True, capture_output=True).stdout.strip(),
            'note': 'shared host; SponsorAtlas, Crucible and other sessions were running'}


def ch_ms(value):
    """ClickHouse DateTime64(3) text in UTC -> epoch ms."""
    from datetime import datetime, timezone
    return datetime.strptime(value, '%Y-%m-%d %H:%M:%S.%f').replace(tzinfo=timezone.utc).timestamp() * 1000


def project_rows(table):
    exists = clickhouse(f"SELECT count() AS n FROM system.tables WHERE database='default' AND name='{table}'")[0]['n']
    if not int(exists):
        return None
    return clickhouse(f"SELECT * FROM default.{table} WHERE project_id='{PROJECT_ID}' FORMAT JSONEachRow")


def settle(expected, timeout=300, quiet=30):
    """Wait until every sent span is stored or the stored count stops changing for `quiet` seconds."""
    start = time.monotonic(); last = (-1, start)
    while time.monotonic() - start < timeout:
        count = int(clickhouse(f"SELECT count(DISTINCT span_id) AS n FROM default.events_full WHERE project_id='{PROJECT_ID}'")[0]['n'])
        if count >= expected:
            return {'stored': count, 'waited_s': round(time.monotonic() - start, 1), 'reason': 'all_sent_stored'}
        if count != last[0]:
            last = (count, time.monotonic())
        elif time.monotonic() - last[1] >= quiet:
            return {'stored': count, 'waited_s': round(time.monotonic() - start, 1), 'reason': 'stable'}
        time.sleep(2)
    return {'stored': last[0], 'waited_s': timeout, 'reason': 'timeout'}


def api_get(env, path):
    auth = base64.b64encode(f"{env['LANGFUSE_INIT_PROJECT_PUBLIC_KEY']}:{env['LANGFUSE_INIT_PROJECT_SECRET_KEY']}".encode()).decode()
    request = urllib.request.Request(LANGFUSE + path, headers={'Authorization': 'Basic ' + auth})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, None


def api_inventory(env):
    """Every observation the v4 public API returns for the project (v1 list endpoints are 404 in 4.69)."""
    items, cursor, status, pages = [], None, None, 0
    while pages < 100:
        status, body = api_get(env, '/api/public/v2/observations?limit=100' + (f'&cursor={cursor}' if cursor else ''))
        pages += 1
        if status != 200 or not body or not body.get('data'):
            break
        items += body['data']
        cursor = (body.get('meta') or {}).get('cursor')
        if not cursor:
            break
    return {'status': status, 'count': len(items), 'ids': sorted({i.get('id') for i in items}), 'items': items}


def storage_blobs():
    """Everything Langfuse persisted, as bytes: every ClickHouse table, the Langfuse Postgres dump,
    the MinIO event store, Redis' append-only file and the stack logs."""
    blobs = {}
    for row in clickhouse("SELECT name FROM system.tables WHERE database='default' AND engine NOT LIKE '%View%'"):
        out = subprocess.run(['docker', 'exec', CLICKHOUSE, 'clickhouse-client', '--user', 'langfuse', '-q',
                              f"SELECT * FROM default.`{row['name']}` FORMAT JSONEachRow"], capture_output=True, check=True)
        blobs['clickhouse/' + row['name']] = out.stdout
    blobs['langfuse-postgres/pg_dump'] = subprocess.run(['docker', 'exec', 'keel-langfuse-postgres-1', 'pg_dump', '-U', 'langfuse', 'langfuse'],
                                                        capture_output=True, check=True).stdout
    for container, path in [('keel-minio-1', '/data'), ('keel-redis-1', '/data')]:
        blobs.update(tar_members(container, path))
    for service in ['collector', 'langfuse', 'langfuse-worker']:
        logs = subprocess.run(['docker', 'logs', f'keel-{service}-1'], capture_output=True)
        blobs[f'logs/{service}'] = logs.stdout + logs.stderr
    return blobs


def tar_members(container, path):
    import gzip
    import io
    import tarfile
    data = subprocess.run(['docker', 'cp', f'{container}:{path}', '-'], capture_output=True, check=True).stdout
    blobs = {}
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member in archive.getmembers():
            if member.isfile():
                content = archive.extractfile(member).read()
                if content[:2] == b'\x1f\x8b':
                    try:
                        content += gzip.decompress(content)
                    except OSError:
                        pass
                blobs[f'{container.split("-")[1]}{"/" + member.name}'] = content
    return blobs


def stored_facts(rows):
    """Langfuse v4 events_full rows -> spanId -> facts used by summarize(). Span attributes are stored as
    parallel metadata_names/metadata_values arrays; storedMs is the first row's created_at."""
    facts = {}
    for row in rows:
        # Langfuse prefixes span attributes with `attributes.` (resource/scope keys have their own prefixes).
        metadata = {name.removeprefix('attributes.'): value for name, value in zip(row.get('metadata_names') or [], row.get('metadata_values') or [])}
        cost = metadata.get('keel.cost_usd')
        fact = {'storedMs': ch_ms(row['created_at']), 'cost': float(cost) if cost is not None else None,
                'runId': metadata.get('keel.run_id'), 'rows': 1}
        prior = facts.get(row['span_id'])
        if prior:
            fact = {**prior, 'storedMs': min(prior['storedMs'], fact['storedMs']), 'rows': prior['rows'] + 1}
        facts[row['span_id']] = fact
    return facts


def run(out, runs):
    out.mkdir(parents=True, exist_ok=True)
    bench = ROOT / '.tools/bench-venv/bin/python'
    spec = out / 'spec.json'
    # Accounting test price on the local route ($0 real spend) so per-run cost sums are non-trivial.
    spec.write_text(json.dumps({'runs': runs, 'pricing': {'inputPerMillion': 0.15, 'outputPerMillion': 0.6}}))
    env = stack_environment()
    report = {'model': MODEL, 'runs': runs, 'load_before': machine_load()}
    try:
        up(env)
        report['stack_ready_utc'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        batch_env = {**os.environ, 'KEEL_LANGFUSE_PG_URL': f"postgresql://keel:{env['KEEL_POSTGRES_PASSWORD']}@127.0.0.1:15432/keel"}
        started = time.monotonic()
        code = subprocess.run(['python3', str(ROOT / 'scripts/gpu_run.py'), '--local-only', '--timeout-seconds', '3000', '--',
                               str(bench), str(ROOT / 'scripts/with_pii_sidecar.py'), '--',
                               str(bench), str(ROOT / 'services/bench-adapters/local_batch.py'), str(spec), str(out / 'batch'),
                               '--seconds', '2900', '--langfuse', MODEL, '--memory-limit', str(BATCH_LIMIT)],
                              env=batch_env, cwd=ROOT).returncode
        report['batch'] = {'exit_code': code, 'seconds_including_lock_wait': round(time.monotonic() - started),
                           'load_after': machine_load()}
        report['container_memory'] = [json.loads(l) for l in subprocess.run(['docker', 'stats', '--no-stream', '--format', '{{json .}}'],
                                      text=True, capture_output=True).stdout.splitlines() if '"keel-' in l]
        sent = [json.loads(l) for l in (out / 'batch/sent.jsonl').read_text().splitlines() if l.strip()]
        run_rows = [json.loads(l) for l in (out / 'batch/runs.jsonl').read_text().splitlines() if l.strip()]
        report['settle'] = settle(len(sent))
        events = project_rows('events_full') or []
        # The (dead after `down`) project public key is not evidence; every other stored field is kept.
        (out / 'langfuse-events.jsonl').write_text(''.join(json.dumps({k: v for k, v in r.items() if k != 'ingestion_api_key'}, sort_keys=True, ensure_ascii=False) + '\n' for r in events))
        report['table_rows'] = {name: (None if rows is None else len(rows)) for name, rows in
                                {n: project_rows(n) for n in ['events_full', 'events_core', 'observations', 'traces']}.items()}
        api = api_inventory(env)
        sent_ids = {s['spanId'] for s in sent}
        report['public_api'] = {'endpoint': '/api/public/v2/observations', 'status': api['status'], 'count': api['count'],
                                'sent_ids_returned': len(sent_ids & set(api['ids']))}
        report['langfuse_cost_fields'] = {'total_cost_sum': sum(float(r.get('total_cost') or 0) for r in events),
                                          'note': 'Langfuse has no price for keel-local; per-run cost is the keel.cost_usd attribute'}
        report['summary'] = summarize(sent, stored_facts(events),
                                      [{'runId': r['runId'], 'knownUsd': (r['cost'] or {}).get('knownUsd', 0)} for r in run_rows])
        canaries = json.loads((out / 'batch/done.json').read_text())['canaries']
        blobs = storage_blobs()
        blobs['public-api/responses'] = json.dumps(api).encode()
        hits = scan_for_canaries(blobs, canaries)
        # Positive control: Keel's own run store keeps the raw task by design, so the scanner must find canaries there.
        control = subprocess.run(['docker', 'exec', POSTGRES, 'pg_dump', '-U', 'keel', 'keel'], capture_output=True, check=True).stdout
        report['pii'] = {'canaries': len(canaries), 'langfuse_blobs_scanned': len(blobs),
                         'langfuse_bytes_scanned': sum(map(len, blobs.values())), 'raw_pii_hits': hits,
                         'positive_control_keel_run_store_hits': len(scan_for_canaries({'keel': control}, canaries).get('keel', []))}
        report['runs_summary'] = {'statuses': {s: sum(1 for r in run_rows if r['status'] == s) for s in {r['status'] for r in run_rows}},
                                  'model_calls': sum(r['budget']['modelCalls'] for r in run_rows),
                                  'tool_calls': sum(r['budget']['toolCalls'] for r in run_rows)}
    finally:
        down()
        report['stack_removed'] = not subprocess.run(['docker', 'ps', '-aq', '--filter', 'label=com.keel.project=keel'],
                                                     text=True, capture_output=True).stdout.strip()
        (out / 'summary.json').write_text(json.dumps(report, indent=1, sort_keys=True))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('explore').add_argument('out', type=Path)
    runner = sub.add_parser('run'); runner.add_argument('out', type=Path); runner.add_argument('--runs', type=int, default=30)
    sub.add_parser('down')
    args = parser.parse_args()
    if args.command == 'explore':
        explore(args.out)
    elif args.command == 'run':
        report = run(args.out, args.runs)
        print(json.dumps({k: report.get(k) for k in ['batch', 'settle', 'public_api', 'pii', 'runs_summary']}, indent=1))
    elif args.command == 'down':
        down()


if __name__ == '__main__':
    main()

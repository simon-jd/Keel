#!/usr/bin/env python3
"""Project-scoped Azure cleanup. Never discovers or mutates other resource groups."""
import argparse
from datetime import datetime, timezone
import json
import re
import subprocess
import sys

SUBSCRIPTION = '<azure-subscription-id>'
GROUP = 'rg-keel-lab'
TAGS = {'project': 'keel', 'owner': 'codex-keel'}
PREFIX = f'/subscriptions/{SUBSCRIPTION}/resourceGroups/{GROUP}'
# Deliberately conservative: ambiguous/encoded/path-traversal IDs are never passed to az.
RESOURCE_ID = re.compile(re.escape(PREFIX) + r'/providers/[A-Za-z0-9.-]+(?:/[A-Za-z0-9_-]+/[A-Za-z0-9_.()-]+)+', re.I)


def az(*args):
    result = subprocess.run(['az', *args, '--subscription', SUBSCRIPTION,
                             '--output', 'json', '--only-show-errors'], capture_output=True, text=True)
    if result.returncode:
        raise ValueError('Azure command failed; no further actions performed (check az login/permissions).')
    return json.loads(result.stdout) if result.stdout.strip() else None


def account():
    # --subscription explicitly selects the pinned subscription; no global az account set.
    current = az('account', 'show')
    if (current.get('id', '').lower() != SUBSCRIPTION or current.get('name') != 'Azure for Students'
            or current.get('state') != 'Enabled'):
        raise ValueError('Unknown or disabled subscription: refusing cleanup.')


def ttl_valid(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z', value):
        return False
    try:
        datetime.fromisoformat(value.replace('Z', '+00:00'))
        return True
    except ValueError:
        return False


def ttl_expired(value, now):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z', value):
        return False
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')) < now
    except ValueError:
        return False


def owned(resource):
    return (isinstance(resource, dict)
            and isinstance(resource.get('id'), str)
            and RESOURCE_ID.fullmatch(resource['id']) is not None
            and all(segment not in ('.', '..') for segment in resource['id'].split('/'))
            and resource.get('resourceGroup', '').lower() == GROUP
            and isinstance(resource.get('tags'), dict)
            and all(resource['tags'].get(k) == v for k, v in TAGS.items()))


def reap(dry_run):
    account()
    if az('group', 'exists', '--name', GROUP) is False:
        return {'scope': GROUP, 'exists': False, 'dry_run': dry_run, 'scanned': 0, 'eligible': 0, 'deleted': 0, 'skipped': 0}
    resources = az('resource', 'list', '--resource-group', GROUP)
    if not isinstance(resources, list):
        raise ValueError('Malformed resource listing; refusing cleanup.')
    summary = {'scope': GROUP, 'dry_run': dry_run, 'scanned': len(resources), 'eligible': 0, 'deleted': 0, 'skipped': 0}
    if not all(owned(r) and ttl_valid(r['tags'].get('ttl')) for r in resources):
        raise ValueError('Anomalous/unowned resource inventory: entire cleanup pass blocked.')
    now = datetime.now(timezone.utc)
    # Build all candidates before mutation so malformed lists cannot cause partial parsing surprises.
    candidates = [r for r in resources if owned(r) and ttl_expired(r['tags'].get('ttl'), now)]
    summary['eligible'] = len(candidates)
    summary['skipped'] = len(resources) - len(candidates)
    if not dry_run:
        for candidate in candidates:
            # Re-check actual current tags/TTL immediately before deletion.
            fresh = az('resource', 'show', '--ids', candidate['id'])
            if (owned(fresh) and fresh['id'].lower() == candidate['id'].lower()
                    and ttl_expired(fresh['tags'].get('ttl'), datetime.now(timezone.utc))):
                az('resource', 'delete', '--ids', fresh['id'])
                summary['deleted'] += 1
    return summary


def down(execute):
    account()
    if az('group', 'exists', '--name', GROUP) is False:
        return {'scope': GROUP, 'exists': False, 'deleted': False}
    group = az('group', 'show', '--name', GROUP)
    if (group.get('id', '').lower() != PREFIX.lower() or group.get('name', '').lower() != GROUP
            or not isinstance(group.get('tags'), dict)
            or any(group['tags'].get(k) != v for k, v in TAGS.items())):
        raise ValueError('Resource group identity/tags do not match Keel; refusing deletion.')
    resources = az('resource', 'list', '--resource-group', GROUP)
    if not isinstance(resources, list) or not all(owned(r) for r in resources):
        raise ValueError('Group contains unknown/unowned resources; refusing whole-group deletion.')
    preview = {'scope': GROUP, 'resources': len(resources), 'action': 'DELETE ENTIRE rg-keel-lab', 'deleted': False}
    print(json.dumps(preview), flush=True)
    if execute:
        az('group', 'delete', '--name', GROUP, '--yes')
        preview['deleted'] = True
    return preview


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest='action', required=True)
    subs.add_parser('reap').add_argument('--dry-run', action='store_true')
    subs.add_parser('down').add_argument('--execute', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(reap(args.dry_run) if args.action == 'reap' else down(args.execute)))
    except (ValueError, TypeError, AttributeError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

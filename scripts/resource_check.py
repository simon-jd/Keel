#!/usr/bin/env python3
"""Read-only project disk, Docker, Compose-memory and pre-download admission checks."""
import argparse
from contextvars import ContextVar
import errno
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / 'infra/docker-compose.yml'
PROJECT_BYTES = 16_000_000_000  # project disk share, doubled on 2026-10-27
MEMORY_BYTES = 16_000_000_000
DOCKER_EXECUTABLE = 'docker'
# A controller may scope Docker inspection to a birth-tracked runner in its
# monitor thread. All other callers retain subprocess.run's existing behavior.
DOCKER_RUNNER = ContextVar('resource_check_docker_runner', default=subprocess.run)


def nonnegative(value):
    if isinstance(value, bool) or not str(value).isdigit():
        raise ValueError('Bytes must be nonnegative integers, never unknown/NaN.')
    return int(value)


def docker(*args, as_json=False):
    result = DOCKER_RUNNER.get()([DOCKER_EXECUTABLE, *args], capture_output=True, text=True, timeout=10)
    if result.returncode:
        raise ValueError('Scoped Docker inspection failed; usage is unknown, admission denied.')
    return json.loads(result.stdout) if as_json else result.stdout.splitlines()


def compose_config():
    # No interpolation: never print .env credentials, never start/pull services.
    return docker('compose', '--file', str(COMPOSE), 'config', '--no-interpolate', '--format', 'json', as_json=True)


def memory(value):
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if not isinstance(value, str):
        raise ValueError('Every service requires a finite mem_limit.')
    match = re.fullmatch(r'([1-9][0-9]*)([bkmg]?)', value.lower())
    if not match:
        raise ValueError('Invalid memory unit; use integer bytes or b/k/m/g.')
    return int(match[1]) * {'':1, 'b':1, 'k':1024, 'm':1024**2, 'g':1024**3}[match[2]]


def check_compose(config):
    if config.get('name') != 'keel' or not isinstance(config.get('services'), dict) or not config['services']:
        raise ValueError('Compose must contain services and have project name keel.')
    limits = {}
    for name, service in config['services'].items():
        if service.get('labels', {}).get('com.keel.project') != 'keel':
            raise ValueError('Every service must carry the Keel project label.')
        amount = memory(service.get('mem_limit'))
        if amount <= 0:
            raise ValueError('Service memory must have a positive hard limit.')
        replicas = service.get('deploy', {}).get('replicas', 1)
        if replicas != 1:
            raise ValueError('Only one replica per service is budgeted; scale-out needs a new memory check.')
        limits[name] = amount
    total = sum(limits.values())
    if total > MEMORY_BYTES:
        raise ValueError('Compose memory exceeds the 16 GB project limit.')
    return {'project':'keel', 'memory_bytes':total, 'limit_bytes':MEMORY_BYTES, 'services':limits}


def directory_bytes(directory, seen=None):
    """Commit a complete scan only; transient removals permit three fresh scans."""
    root = Path(directory)
    baseline = set() if seen is None else set(seen)
    for attempt in range(3):
        scanned = set(baseline)
        total = 0
        try:
            if root.is_symlink():
                raise ValueError('Usage directory symlinked; size unknown.')
            if not root.is_dir():
                raise FileNotFoundError(errno.ENOENT, 'Usage directory missing', str(root))
            def onerror(error):
                raise error
            for current, dirs, files in os.walk(root, followlinks=False, onerror=onerror):
                dirs[:] = [name for name in dirs if not (Path(current) / name).is_symlink()]
                for name in files:
                    entry = Path(current) / name
                    info = entry.lstat()
                    identity = (info.st_dev, info.st_ino)
                    if entry.is_symlink() or identity in scanned:
                        continue
                    scanned.add(identity)
                    total += info.st_blocks * 512
        except OSError as error:
            if error.errno == errno.ENOENT and attempt < 2:
                continue
            raise
        if seen is not None:
            seen.update(scanned)
        return total
    raise AssertionError('Unreachable scan state')


PROJECT_LABELS = ('com.docker.compose.project', 'com.keel.project', 'project')


def project_owned(labels):
    return isinstance(labels, dict) and any(labels.get(key) == 'keel' for key in PROJECT_LABELS)


def owned_ids(*prefix):
    return sorted({identity for label in PROJECT_LABELS
                   for identity in docker(*prefix, '--quiet', '--filter', f'label={label}=keel')})


def docker_on_project_filesystem(project_directory, docker_root, stat=os.stat):
    """Docker data counts toward the share only while it lives on the project's filesystem."""
    return stat(project_directory).st_dev == stat(docker_root).st_dev


def disk_report(project_directory, limit, planned=0):
    if not 0 < limit <= PROJECT_BYTES:
        raise ValueError('Disk limit may be tightened but cannot exceed 16 GB.')
    seen = set()
    local_bytes = directory_bytes(project_directory, seen)
    config = compose_config()
    if config.get('name') != 'keel':
        raise ValueError('Unexpected Compose project.')
    images = set(owned_ids('image', 'ls', '--no-trunc'))
    missing = []
    for reference in sorted({service['image'] for service in config['services'].values()}):
        ids = docker('image', 'ls', '--quiet', '--no-trunc', '--filter', f'reference={reference}')
        images.update(ids)
        if not ids:
            missing.append(reference)
    docker_root = docker('info', '--format', '{{.DockerRootDir}}')[0].strip()
    counted = docker_on_project_filesystem(project_directory, docker_root)
    # Volume directories are root-owned; size them only when they count toward the share.
    volume_bytes = 0 if counted else None
    volumes = owned_ids('volume', 'ls')
    for volume in volumes:
        details = docker('volume', 'inspect', volume, as_json=True)
        if len(details) != 1 or not project_owned(details[0].get('Labels')):
            raise ValueError('Volume ownership changed or unknown.')
        if counted:
            volume_bytes += directory_bytes(details[0]['Mountpoint'], seen)
    writable = 0
    containers = owned_ids('ps', '--all')
    if containers:
        details = docker('container', 'inspect', '--size', *containers, as_json=True)
        if len(details) != len(containers):
            raise ValueError('Incomplete container inventory.')
        for item in details:
            if not project_owned(item.get('Config', {}).get('Labels')):
                raise ValueError('Container ownership changed or unknown.')
            image_id = item.get('Image')
            if not isinstance(image_id, str) or not image_id:
                raise ValueError('Container image ID is unknown; admission denied.')
            images.add(image_id)
            writable += nonnegative(item.get('SizeRw'))
    # Tags can move while existing containers retain an untagged old image. Inspect the
    # union of configured/labeled images and every owned container Image ID exactly once.
    image_bytes = 0
    if images:
        details = docker('image', 'inspect', *sorted(images), as_json=True)
        if len(details) != len(images) or {item['Id'] for item in details} != images:
            raise ValueError('Incomplete image inventory.')
        image_bytes = sum(nonnegative(item.get('Size')) for item in details)
    docker_bytes = image_bytes + (volume_bytes or 0) + writable
    total = local_bytes + (docker_bytes if counted else 0) + planned
    return {'project':'keel', 'project_bytes':local_bytes, 'image_bytes':image_bytes,
            'volume_bytes':volume_bytes, 'container_writable_bytes':writable, 'planned_bytes':planned,
            'docker_root':docker_root, 'docker_bytes_counted':counted,
            'total_bytes':total, 'limit_bytes':limit, 'admitted':total <= limit,
            'missing_images_not_pulled':missing,
            'note':'Docker images/volumes/layers count at full size only when Docker data is on the project filesystem '
                   '(volume_bytes is null when they do not count and were not sized); shared HF cache excluded.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest='action', required=True)
    compose = subs.add_parser('compose')
    compose.add_argument('--config-json', type=Path, help='Validate an already normalized Compose config.')
    download = subs.add_parser('download')
    download.add_argument('--download-bytes', required=True)
    download.add_argument('--free-bytes', help='Conservative simulation; never exceeds observed disk free.')
    download.add_argument('--destination', type=Path, default=ROOT)
    disk = subs.add_parser('disk')
    disk.add_argument('--project-directory', type=Path, default=ROOT)
    disk.add_argument('--limit-bytes', default=str(PROJECT_BYTES))
    disk.add_argument('--planned-bytes', default='0')
    args = parser.parse_args()
    try:
        if args.action == 'compose':
            result = check_compose(json.loads(args.config_json.read_text()) if args.config_json else compose_config())
        elif args.action == 'download':
            size = nonnegative(args.download_bytes)
            free = shutil.disk_usage(args.destination).free
            if args.free_bytes is not None:
                free = min(free, nonnegative(args.free_bytes))
            required = size + (50_000_000_000 if size > 5_000_000_000 else 0)
            result = {'download_bytes':size, 'free_bytes':free, 'required_free_bytes':required,
                      'admitted':free >= required}
        else:
            result = disk_report(args.project_directory, nonnegative(args.limit_bytes), nonnegative(args.planned_bytes))
        print(json.dumps(result))
        return 0 if result.get('admitted', True) else 1
    except (ValueError, TypeError, KeyError, AttributeError, OSError, subprocess.TimeoutExpired) as error:
        print(f'Resource admission denied: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

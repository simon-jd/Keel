#!/usr/bin/env python3
"""Run a command with a loopback Presidio sidecar and KEEL_TEST_PII_ENDPOINT set.

Usage: with_pii_sidecar.py -- <command> [args...]
The sidecar is started with this interpreter (it must have the services/pii lock
installed), bound to a free 127.0.0.1 port, and stopped when the command exits.
"""
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def wait_healthy(url, process, timeout=60):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f'PII sidecar exited early with code {process.returncode}')
        try:
            with opener.open(url, timeout=1) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError('PII sidecar did not become healthy')


def main(argv):
    if len(argv) < 2 or argv[0] != '--':
        print(__doc__, file=sys.stderr)
        return 2
    base = f'http://127.0.0.1:{free_port()}'
    port = base.rsplit(':', 1)[1]
    sidecar = subprocess.Popen(
        [sys.executable, '-m', 'uvicorn', 'services.pii.app:app', '--host', '127.0.0.1', '--port', port,
         '--workers', '1', '--loop', 'asyncio', '--http', 'h11', '--no-access-log', '--log-level', 'warning'],
        cwd=ROOT, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
    try:
        wait_healthy(base + '/health', sidecar)
        return subprocess.call(argv[1:], env={**os.environ, 'KEEL_TEST_PII_ENDPOINT': base + '/redact'})
    finally:
        sidecar.terminate()
        try:
            sidecar.wait(10)
        except subprocess.TimeoutExpired:
            sidecar.kill()
            sidecar.wait()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

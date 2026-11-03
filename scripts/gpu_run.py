#!/usr/bin/env python3
"""Queue local GPU batches under a shared flock and clean only their process groups."""
import argparse
import fcntl
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen

SHARED_LOCK = Path('/var/tmp/rtx4090.lock')


class Stopped(Exception):
    def __init__(self, signum):
        self.signum = signum


def stop(signum, _frame):
    raise Stopped(signum)


def terminate_group(process, grace):
    # The child was started in a fresh session. Never enumerate/kill unrelated GPU processes.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait()
        return
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            break
        time.sleep(min(.02, max(0, deadline - time.monotonic())))
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def lock_path(test_directory):
    if test_directory is None:
        return SHARED_LOCK
    directory = Path(test_directory)
    info = directory.lstat()
    if (directory.is_symlink() or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700
            or not directory.name.startswith('keel-gpu-test-')
            or not directory.resolve().is_relative_to(Path('/tmp').resolve())):
        raise ValueError('Test lock must be in an owned private /tmp/keel-gpu-test-* directory.')
    return directory / 'rtx4090.lock'


def local_environment():
    env = dict(os.environ)
    for name in list(env):
        if name.endswith('_API_KEY') or name in {'AZURE_OPENAI_ENDPOINT', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_ORG_ID'}:
            del env[name]
    shared = Path.home() / '.cache/huggingface'
    local = Path(__file__).resolve().parents[1] / '.tools/gpu-cache'
    env.update(HF_HOME=str(shared),
               HF_HUB_CACHE=str(shared / 'hub'), HUGGINGFACE_HUB_CACHE=str(shared / 'hub'),
               TRANSFORMERS_CACHE=str(shared / 'hub'), HF_XET_CACHE=str(shared / 'xet'),
               HF_ASSETS_CACHE=str(shared / 'assets'), HF_MODULES_CACHE=str(local / 'modules'),
               VLLM_CACHE_ROOT=str(local / 'vllm'), TRITON_CACHE_DIR=str(local / 'triton'),
               TORCHINDUCTOR_CACHE_DIR=str(local / 'inductor'), CUDA_CACHE_PATH=str(local / 'cuda'),
               XDG_CACHE_HOME=str(local / 'xdg'), NUMBA_CACHE_DIR=str(local / 'numba'),
               PYTHONDONTWRITEBYTECODE='1',
               OPENAI_BASE_URL='http://127.0.0.1:18000/v1',
               ANTHROPIC_BASE_URL='http://127.0.0.1:18000')
    return env


def run(args):
    if not args.local_only:
        raise ValueError('Explicit --local-only required; paid batches must use budget.py first and Task8 adapters.')
    if not 0 < args.timeout_seconds <= 14400 or not 0 < args.grace_seconds <= 30:
        raise ValueError('Timeout must be positive and at most four hours; grace at most 30 seconds.')
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        raise ValueError('A finite batch command is required.')
    path = lock_path(args.test_lock_directory)
    children = []
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, stop)
    with os.fdopen(os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o666), 'a+') as lock:
        # Acquisition time is outside occupancy time. No GPU command starts until lock acquisition.
        fcntl.flock(lock, fcntl.LOCK_EX)
        env = local_environment()
        deadline = time.monotonic() + args.timeout_seconds
        try:
            if args.serve_model:
                if args.test_lock_directory:
                    raise ValueError('vLLM cannot run under an isolated test lock.')
                server = subprocess.Popen(['vllm', 'serve', args.serve_model, '--gpu-memory-utilization', '0.80',
                                           '--host', '127.0.0.1', '--port', '18000'], env=env, start_new_session=True)
                children.append(server)
                startup_deadline = min(deadline, time.monotonic() + 120)
                while True:
                    if server.poll() is not None:
                        raise ValueError('Local vLLM stopped before readiness.')
                    try:
                        with urlopen('http://127.0.0.1:18000/health', timeout=.5) as response:
                            if response.status == 200:
                                break
                    except (URLError, TimeoutError):
                        pass
                    if time.monotonic() >= startup_deadline:
                        raise subprocess.TimeoutExpired('vllm startup', 120)
                    time.sleep(.1)
            child = subprocess.Popen(command, env=env, start_new_session=True)
            children.append(child)
            code = child.wait(timeout=max(.001, deadline - time.monotonic()))
            return code if code >= 0 else 128 - code
        except subprocess.TimeoutExpired:
            return 124
        except Stopped as error:
            return 128 + error.signum
        finally:
            # Ignore repeated termination while cleaning; still escalate every owned group to KILL.
            for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                signal.signal(signum, signal.SIG_IGN)
            for child in reversed(children):
                terminate_group(child, args.grace_seconds)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--local-only', action='store_true')
    parser.add_argument('--timeout-seconds', type=float, default=14400)
    parser.add_argument('--grace-seconds', type=float, default=5)
    parser.add_argument('--test-lock-directory', help='CPU-only tests: owned mode-0700 /tmp/keel-gpu-test-* directory')
    parser.add_argument('--serve-model', help='Start local vLLM for this batch only (requires preinstalled vLLM/cache).')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    try:
        return run(args)
    except Stopped as error:
        return 128 + error.signum
    except (ValueError, OSError) as error:
        print(f'GPU batch denied: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

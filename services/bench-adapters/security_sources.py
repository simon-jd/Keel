"""Verify the separate security benchmark source pins before importing upstream code."""
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import hashlib
import json
from pathlib import Path
import threading

ROOT = Path(__file__).resolve().parents[2]
LOCK_PATH = Path(__file__).with_name('security-upstream.lock.json')


def source_root(name):
    lock = json.loads(LOCK_PATH.read_text())
    entry = lock['sources'][name]
    root = ROOT / '.tools/bench-upstream' / f"{name}-{entry['commit']}"
    for relative, expected in entry['files'].items():
        path = root / relative
        if path.is_symlink() or not path.is_file():
            raise RuntimeError('SECURITY_SOURCE_MISSING')
        raw = path.read_bytes()
        if len(raw) != expected['bytes'] or hashlib.sha256(raw).hexdigest() != expected['sha256']:
            raise RuntimeError('SECURITY_SOURCE_MISMATCH')
    return root


def source_identity(name):
    entry = json.loads(LOCK_PATH.read_text())['sources'][name]
    return {key: entry[key] for key in ('repository', 'commit', 'root_tree', 'license')}


_CPU_SERIAL = threading.Lock()


class PrivateOutput:
    """Bounded private upstream diagnostics; original full model outputs stay in rows."""
    def __init__(self):
        self.text = ''
        self.truncated = False

    def write(self, value):
        remaining = 64_000 - len(self.text)
        self.text += value[:remaining]
        self.truncated |= len(value) > remaining
        return len(value)

    def flush(self):
        pass

    def evidence(self):
        return {'text': self.text, 'truncated': self.truncated}


@contextmanager
def private_output():
    # stdout/cwd/import changes are process-global. Serialize adapter execution.
    with _CPU_SERIAL:
        output = PrivateOutput()
        with redirect_stdout(output), redirect_stderr(output):
            yield output

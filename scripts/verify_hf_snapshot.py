#!/usr/bin/env python3
"""Check a downloaded Hugging Face snapshot against the publisher's file ids.

usage: verify_hf_snapshot.py <models-api.json> <snapshot-dir>
The API json is https://huggingface.co/api/models/<repo>?blobs=true for the pinned revision.
LFS files are checked by sha256, small files by git blob id (sha1 of "blob <size>\\0" + bytes).
Prints one JSON object; exit 0 only if every listed file is present and matches.
"""
import hashlib
import json
from pathlib import Path
import sys


def file_ids(path):
    sha256, sha1 = hashlib.sha256(), hashlib.sha1()
    sha1.update(b'blob %d\0' % path.stat().st_size)
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            sha256.update(block)
            sha1.update(block)
    return sha256.hexdigest(), sha1.hexdigest()


def verify(api, snapshot):
    rows = []
    for sibling in api['siblings']:
        path = snapshot / sibling['rfilename']
        if not path.is_file():
            rows.append({'file': sibling['rfilename'], 'ok': False, 'reason': 'missing'})
            continue
        sha256, blob = file_ids(path)
        lfs = (sibling.get('lfs') or {}).get('sha256')
        ok = sha256 == lfs if lfs else blob == sibling.get('blobId')
        rows.append({'file': sibling['rfilename'], 'ok': ok, 'bytes': path.stat().st_size, 'check': 'sha256' if lfs else 'git-blob', 'sha256': sha256})
    return {'repo': api['id'], 'revision': api['sha'], 'files': rows, 'all_ok': all(r['ok'] for r in rows)}


if __name__ == '__main__':
    result = verify(json.loads(Path(sys.argv[1]).read_text()), Path(sys.argv[2]))
    print(json.dumps(result, indent=1))
    sys.exit(0 if result['all_ok'] else 1)

"""Private Task10 identity key. No CLI roots, implicit creation or public salts."""
import hashlib
import hmac
import json
import os
import stat
from pathlib import Path
import secrets
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from annotation_material import ROOT,encoded,owned,read_private,require,sha,write_private
PRIVATE=ROOT/'.tools/regression-task10-v2'
VERSION='hmac-sha256-private-identity-v2'

def create():
    # mkdir and each O_EXCL private write must fail rather than repair/rekey.
    parent=PRIVATE.parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid==os.getuid(),'IDENTITY_PARENT')
    require(all(not p.is_symlink() for p in PRIVATE.parents),'IDENTITY_PARENT_SYMLINK')
    PRIVATE.mkdir(mode=0o700)
    owned(PRIVATE,True)
    secret=secrets.token_bytes(32)
    write_private(PRIVATE/'identity.key',secret)
    write_private(PRIVATE/'identity.json',encoded({'schema':1,'algorithm':VERSION,'keySha256':sha(secret)})+b'\n')

def key():
    # Strict owner/mode/no-symlink checks include the fixed directory and parents.
    owned(PRIVATE,True)
    secret=read_private(PRIVATE/'identity.key',32)
    binding=json.loads(read_private(PRIVATE/'identity.json',4096))
    require(len(secret)==32 and binding=={'schema':1,'algorithm':VERSION,'keySha256':sha(secret)},'IDENTITY_KEY_CHANGED')
    return secret

def commit(secret,scope,value):
    require(isinstance(secret,bytes) and len(secret)==32 and scope in ('case','task','semantic','run') and isinstance(value,str),'IDENTITY_INPUT')
    return hmac.new(secret,encoded([VERSION,scope,value]),hashlib.sha256).hexdigest()

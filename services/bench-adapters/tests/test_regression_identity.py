"""Disposable fixture keys only; never log a key or a source case."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
SPEC=importlib.util.spec_from_file_location('regression_identity',Path(__file__).resolve().parents[3]/'scripts/regression_identity.py')
module=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)

class RegressionIdentityTests(unittest.TestCase):
    def test_keyed_blind_and_source_commitments_defeat_both_dictionaries(self):
        key=b'a'*32;semantic=module.sha(b'known blind unit');task=module.sha(b'public entry')
        first=module.commit(key,'case',semantic);source=module.commit(key,'task',task)
        for prefix in ('','task10-public:','task10-semantic:'):
            self.assertNotEqual(first,module.sha((prefix+semantic).encode()))
            self.assertNotEqual(source,module.sha((prefix+task).encode()))
        self.assertNotEqual(first,module.commit(b'b'*32,'case',semantic))
        self.assertNotEqual(source,module.commit(b'b'*32,'task',task))
        self.assertNotEqual(module.commit(key,'case',semantic),module.commit(key,'semantic',semantic))
    def test_exclusive_key_generation_stability_and_verify_never_creates(self):
        with tempfile.TemporaryDirectory() as d:
            directory=Path(d)/'new'
            with patch.object(module,'PRIVATE',directory):
                with self.assertRaises(FileNotFoundError):module.key()
                self.assertFalse(directory.exists())
                module.create();before={p.name:(p.read_bytes(),p.stat().st_ino,p.stat().st_mtime_ns) for p in directory.iterdir()}
                self.assertEqual(module.key(),module.key());after={p.name:(p.read_bytes(),p.stat().st_ino,p.stat().st_mtime_ns) for p in directory.iterdir()}
                self.assertEqual(before,after)
                with self.assertRaises(FileExistsError):module.create()
                (directory/'identity.key').unlink()
                with self.assertRaises(FileNotFoundError):module.key()
                self.assertFalse((directory/'identity.key').exists())
    def test_changed_key_wrong_mode_symlink_and_parent_symlink_fail(self):
        for change in ('changed','mode','link','parent'):
            with self.subTest(change=change),tempfile.TemporaryDirectory() as d:
                directory=Path(d)/'private'
                with patch.object(module,'PRIVATE',directory):module.create()
                path=directory/'identity.key'
                if change=='changed':path.write_bytes(b'z'*32)
                if change=='mode':path.chmod(0o644)
                if change=='link':path.rename(directory/'real');path.symlink_to(directory/'real')
                if change=='parent':
                    link=Path(d)/'linked';link.symlink_to(directory,target_is_directory=True);directory=link
                with patch.object(module,'PRIVATE',directory),self.assertRaises(ValueError):module.key()

if __name__=='__main__':unittest.main()

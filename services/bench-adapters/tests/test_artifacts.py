import gzip,json,os,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from resources import DISK_STOP
class ArtifactTests(unittest.TestCase):
    def test_private_roundtrip_and_capacity_fail_closed(self):
        from artifacts import ArtifactStore, ArtifactLimit
        with tempfile.TemporaryDirectory() as tmp:
            store=ArtifactStore(Path(tmp)/'private',total_limit=1000,job_limit=1000,disk_usage=lambda:0)
            data={'job_id':1,'run_id':'run','calls':[{'call_id':'call','messages':[{'role':'user','content':'synthetic'}],'action':{'content':'answer'}}]}
            ref=store.write('sample',data)
            path=store.directory/ref['file']
            self.assertEqual(json.loads(gzip.decompress(path.read_bytes())),data)
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            self.assertEqual(store.directory.stat().st_mode&0o777,0o700)
            with self.assertRaises(ArtifactLimit):store.write('large',{'body':os.urandom(2000).hex()})
            self.assertEqual(len(list(store.directory.iterdir())),1)
            with self.assertRaises(ArtifactLimit):ArtifactStore(store.directory,disk_usage=lambda:DISK_STOP).write('over',data)

    def test_disk_scan_is_reused_briefly_and_counts_bytes_written_since(self):
        from artifacts import ArtifactStore, ArtifactLimit
        scans=[]
        def usage():
            scans.append(1);return DISK_STOP-5_000_000
        now=[0.0]
        with tempfile.TemporaryDirectory() as tmp:
            store=ArtifactStore(Path(tmp)/'private',disk_usage=usage,clock=lambda:now[0])
            for i in range(3):store.write(f'a{i}',{'i':i})
            self.assertEqual(len(scans),1)
            # Each write is charged a 4 KiB block plus the 2 MB margin against the cached total.
            store.disk_usage=lambda:DISK_STOP-2_000_000;store._scanned_at=None
            with self.assertRaises(ArtifactLimit):store.write('b0',{'i':0})
            store.disk_usage=usage;store._scanned_at=None
            store.write('c0',{'i':0});store.write('c1',{'i':1})
            self.assertEqual(len(scans),2)
            now[0]=31.0;store.write('c2',{'i':2})
            self.assertEqual(len(scans),3)

    def test_cached_total_includes_earlier_writes(self):
        from artifacts import ArtifactStore, ArtifactLimit
        with tempfile.TemporaryDirectory() as tmp:
            store=ArtifactStore(Path(tmp)/'private',disk_usage=lambda:DISK_STOP-2_000_000-4096,clock=lambda:0.0)
            store.write('first',{'i':0})
            with self.assertRaises(ArtifactLimit):store.write('second',{'i':1})

import errno
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'scripts'))
import resource_check

class ScanTests(unittest.TestCase):
    def test_transient_removal_rescans_entire_root_with_fresh_inode_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'one').write_bytes(b'a');(root/'two').write_bytes(b'b')
            expected=sum(p.stat().st_blocks*512 for p in root.iterdir())
            original=resource_check.os.walk;attempts=[];seen=set()
            def race(*args,**kwargs):
                attempts.append(1)
                if len(attempts)==1:
                    yield str(root),[],['one']
                    raise FileNotFoundError(errno.ENOENT,'removed',str(root/'transient'))
                yield from original(*args,**kwargs)
            with patch.object(resource_check.os,'walk',race):
                self.assertEqual(resource_check.directory_bytes(root,seen),expected)
            self.assertEqual(len(attempts),2)
            self.assertEqual(len(seen),2)

    def test_exhausted_or_permission_failure_never_commits_partial_seen(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'one').write_bytes(b'a')
            for error,expected in [(FileNotFoundError(errno.ENOENT,'race'),3),(PermissionError(errno.EACCES,'denied'),1)]:
                attempts=[];seen={(0,0)}
                def broken(*args,**kwargs):
                    attempts.append(1);yield str(root),[],['one'];raise error
                with patch.object(resource_check.os,'walk',broken),self.assertRaises(type(error)):
                    resource_check.directory_bytes(root,seen)
                self.assertEqual(seen,{(0,0)})
                self.assertEqual(len(attempts),expected)

class LiveAdmissionTests(unittest.TestCase):
    def test_changed_docker_categories_stop_batch_and_artifact_admission(self):
        import resources
        from artifacts import ArtifactStore,ArtifactLimit
        with tempfile.TemporaryDirectory() as tmp:
            for category in ['image_bytes','volume_bytes','container_writable_bytes']:
                current={'project_bytes':resources.DISK_STOP-250000000,'image_bytes':0,'volume_bytes':0,'container_writable_bytes':0}
                def snapshot(*args,**kwargs):return {**current,'total_bytes':sum(current.values())}
                with patch.object(resource_check,'disk_report',snapshot),patch.object(resources,'memory_snapshot',return_value={'batch_rss_bytes':100,'other_reserved_bytes':0}):
                    resources.admit_resources()
                    ArtifactStore(Path(tmp)/category).write('small',{'synthetic':True})
                    current[category]=300000000
                    with self.assertRaises(ValueError):resources.admit_resources()
                    with self.assertRaises(ArtifactLimit):ArtifactStore(Path(tmp)/category).write('blocked',{})

    def test_unknown_current_inventory_stops_artifact_write(self):
        from artifacts import ArtifactStore,ArtifactLimit
        with tempfile.TemporaryDirectory() as tmp,patch.object(resource_check,'disk_report',side_effect=PermissionError('unknown')):
            with self.assertRaisesRegex(ArtifactLimit,'ARTIFACT_RESOURCE_UNKNOWN'):
                ArtifactStore(Path(tmp)/'private').write('blocked',{})
            self.assertEqual(list((Path(tmp)/'private').iterdir()),[])

    def test_other_project_memory_reservation_reduces_available_batch_budget(self):
        import resources
        with patch.object(resource_check,'disk_report',return_value={'total_bytes':1}),patch.object(resources,'memory_snapshot',return_value={'batch_rss_bytes':100,'other_reserved_bytes':resources.TOTAL_MEMORY_LIMIT-resources.BATCH_MEMORY_LIMIT+1}):
            with self.assertRaises(ValueError):resources.admit_resources()
        with patch.object(resource_check,'disk_report',return_value={'total_bytes':1}),patch.object(resources,'memory_snapshot',return_value={'batch_rss_bytes':100,'other_reserved_bytes':resources.TOTAL_MEMORY_LIMIT-resources.BATCH_MEMORY_LIMIT}):
            resources.admit_resources()

    def test_tighter_batch_cap_admits_beside_running_services_and_still_stops_the_batch(self):
        # A batch running next to the Langfuse stack: 9 GB of service limits leaves room for a 5 GB batch, not 12 GB.
        import resources
        snapshot=lambda rss:{'batch_rss_bytes':rss,'other_reserved_bytes':9_000_000_000}
        with patch.object(resource_check,'disk_report',return_value={'total_bytes':1}):
            with patch.object(resources,'memory_snapshot',return_value=snapshot(100)):
                with self.assertRaises(ValueError):resources.admit_resources()
                resources.admit_resources(batch_limit=5_000_000_000)
                with self.assertRaises(ValueError):resources.admit_resources(batch_limit=7_000_000_001)
            with patch.object(resources,'memory_snapshot',return_value=snapshot(5_000_000_001)):
                with self.assertRaises(ValueError):resources.admit_resources(batch_limit=5_000_000_000)

    def test_batch_cap_can_only_be_tightened(self):
        import resources
        with patch.object(resource_check,'disk_report',return_value={'total_bytes':1}),patch.object(resources,'memory_snapshot',return_value={'batch_rss_bytes':1,'other_reserved_bytes':0}):
            for bad in [resources.BATCH_MEMORY_LIMIT+1,0,-1,1.5,True]:
                with self.assertRaises(ValueError):resources.admit_resources(batch_limit=bad)

class MemoryInventoryTests(unittest.TestCase):
    def test_readable_external_paths_still_check_cgroup_ownership(self):
        import resources
        from types import SimpleNamespace as S
        parent=S(pid=1,children=lambda recursive:[],parents=lambda:[],memory_info=lambda:S(rss=50))
        service=S(pid=3,info={'pid':3,'name':'node','status':'running','uids':S(real=1000),
                             'cwd':'/','exe':'/usr/bin/node','memory_info':S(rss=resources.TOTAL_MEMORY_LIMIT-resources.BATCH_MEMORY_LIMIT+1)})
        with patch.object(resources.psutil,'Process',return_value=parent),patch.object(resources.psutil,'process_iter',return_value=[service]),patch.object(resource_check,'owned_ids',return_value=[]),patch.object(resources,'disk_snapshot',return_value={'total_bytes':1}),patch.object(Path,'read_text',return_value='0::/user.slice/keel-service.scope') as read:
            report=resources.memory_snapshot()
            self.assertEqual(report['other_native_rss_bytes'],resources.TOTAL_MEMORY_LIMIT-resources.BATCH_MEMORY_LIMIT+1)
            self.assertEqual(report['other_reserved_bytes'],resources.TOTAL_MEMORY_LIMIT-resources.BATCH_MEMORY_LIMIT+1)
            self.assertEqual(read.call_count,1)
            with self.assertRaisesRegex(ValueError,'BATCH_TOTAL_SERVICE_MEMORY_LIMIT'):
                resources.admit_resources()
            service.info['memory_info']=None
            with self.assertRaisesRegex(ValueError,'UNKNOWN_PROJECT_PROCESS_MEMORY'):
                resources.memory_snapshot()
            read.return_value='0::/user.slice/other-project.scope'
            self.assertEqual(resources.memory_snapshot()['other_reserved_bytes'],0)

    def test_owned_services_and_inspection_are_distinct_and_other_projects_excluded(self):
        import resources
        from types import SimpleNamespace as S
        root=resources.ROOT
        def process(pid,cwd,exe,rss,name='python',status='running'):
            return S(pid=pid,info={'pid':pid,'name':name,'status':status,'uids':S(real=1000),'cwd':cwd,'exe':exe,'memory_info':None if rss is None else S(rss=rss)})
        parent=S(pid=1,children=lambda recursive:[],parents=lambda:[S(pid=2)],memory_info=lambda:S(rss=50))
        native=process(3,str(root),'/usr/bin/node',100,'node')
        inspection=process(2,str(root),'/usr/bin/bash',20,'bash')
        other=process(4,None,None,9000000000,'unrelated')
        container={'Config':{'Labels':{'project':'keel'}},'State':{'Running':True},'HostConfig':{'Memory':512}}
        with patch.object(resources.psutil,'Process',return_value=parent),patch.object(resources.psutil,'process_iter',return_value=[native,inspection,other]),patch.object(resource_check,'owned_ids',return_value=['owned']),patch.object(resource_check,'docker',return_value=[container]),patch.object(Path,'read_text',return_value='0::/docker/non-keel-container'):
            report=resources.memory_snapshot()
            self.assertEqual(report['batch_rss_bytes'],50)
            self.assertEqual(report['other_native_rss_bytes'],100)
            self.assertEqual(report['auxiliary_rss_bytes'],20)
            self.assertEqual(report['other_container_reserved_bytes'],512)
            self.assertEqual(report['other_reserved_bytes'],632)
            native.info['memory_info']=None
            with self.assertRaisesRegex(ValueError,'UNKNOWN_PROJECT'):resources.memory_snapshot()
            native.info['memory_info']=S(rss=100);container['HostConfig']['Memory']=0
            with self.assertRaisesRegex(ValueError,'UNBOUNDED'):resources.memory_snapshot()
            container['State']={}
            with self.assertRaisesRegex(ValueError,'UNKNOWN_CONTAINER'):resources.memory_snapshot()

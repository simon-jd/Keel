import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
class Limits(unittest.TestCase):
    def test_install_admission_counts_archive_two_unpacks_and_block_rounding(self):
        from setup_vllm import admitted_peak
        self.assertEqual(admitted_peak(100,50,[1,4097],reserve=20),24746)
        with self.assertRaises(ValueError):admitted_peak(7999999999,1,[1],reserve=0)

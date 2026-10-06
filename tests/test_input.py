import importlib.util
import struct
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("audit", Path(__file__).resolve().parents[1] / "tools/audit_input.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class DiscReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "fixture.iso"

    def disc(self, name=b"default.xex", file_size=4, right=0):
        data = bytearray(40 * 2048)
        data[32 * 2048:32 * 2048 + len(audit.MAGIC)] = audit.MAGIC
        struct.pack_into("<II", data, 32 * 2048 + 20, 33, 14 + len(name))
        struct.pack_into("<HHIIBB", data, 33 * 2048, 0, right, 34, file_size, 0, len(name))
        data[33 * 2048 + 14:33 * 2048 + 14 + len(name)] = name
        data[34 * 2048:34 * 2048 + 4] = b"XEX2"
        self.path.write_bytes(data)

    def test_indexes_file_offsets(self):
        self.disc()
        result = audit.index_iso(self.path)
        self.assertEqual(result["files"]["default.xex"], {"offset": 34 * 2048, "size": 4})

    def test_rejects_empty_extraction(self):
        self.path.write_bytes(b"")
        with self.assertRaisesRegex(ValueError, "empty"):
            audit.index_iso(self.path)

    def test_rejects_out_of_bounds_file(self):
        self.disc(file_size=20000)
        with self.assertRaisesRegex(ValueError, "beyond"):
            audit.index_iso(self.path)

    def test_rejects_directory_traversal(self):
        self.disc(name=b"../bad")
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            audit.index_iso(self.path)

    def test_rejects_invalid_tree_link(self):
        self.disc(right=400)
        with self.assertRaisesRegex(ValueError, "outside"):
            audit.index_iso(self.path)


if __name__ == "__main__":
    unittest.main()

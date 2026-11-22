from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import accessory_analysis_store as store
from independent_parts import PartValidationError


@unittest.skipUnless(sys.platform == "linux", "Linux analysis store")
class AccessoryAnalysisStoreTests(unittest.TestCase):
    def setUp(self):
        root = self.enterContext(tempfile.TemporaryDirectory(prefix="accessory-analysis-"))
        self.enterContext(patch.object(store, "ROOT", Path(root)))
        self.state = Path(root) / "local_state"
        self.state.mkdir(mode=0o700)
        self.folder = self.state / "accessory_analysis"
        self.file = self.folder / store.NAME
        self.rule = {"kind_id": "fixture.pin", "focus": "momentum", "intensity": 3}

    def save(self, revision=0, policies=None):
        return store.run("save", {"expected_revision": revision,
                                  "policies": [self.rule] if policies is None else policies})

    def test_read_does_not_create_and_save_uses_a_private_record(self):
        self.assertEqual(store.run("read", {}), {"schema": 1, "revision": 0, "policies": []})
        self.assertFalse(self.folder.exists())
        result = self.save()
        self.assertEqual(result, {"schema": 1, "revision": 1, "policies": [self.rule]})
        self.assertEqual(store.run("read", {}), result)
        self.assertEqual(self.folder.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.save(1, [])["policies"], [])
        self.assertEqual(list(self.folder.iterdir()), [self.file])

    def test_scope_and_schema_are_strict(self):
        for policies in ([{**self.rule, "intensity": True}], [{**self.rule, "intensity": 4}],
                         [{**self.rule, "kind_id": "../art"}], [self.rule, self.rule],
                         [{**self.rule, "extra": ""}], [self.rule] * 33):
            with self.subTest(policies=policies), self.assertRaises(PartValidationError):
                self.save(policies=policies)
        with self.assertRaises(PartValidationError):
            store.run("read", {"path": "/elsewhere"})
        self.assertFalse(self.folder.exists())

    def test_concurrent_saves_enforce_revision(self):
        def attempt(_):
            try:
                return self.save()["revision"]
            except store.Conflict:
                return "conflict"

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(attempt, range(2)))
        self.assertCountEqual(outcomes, [1, "conflict"])

    def test_symlink_and_hardlink_reject_reads_and_saves(self):
        outside = self.state.parent / "external"
        outside.mkdir(mode=0o700)
        self.folder.symlink_to(outside, target_is_directory=True)
        with self.assertRaises((OSError, PartValidationError)):
            self.save()
        self.assertEqual(list(outside.iterdir()), [])
        self.folder.unlink()
        self.save()
        external = outside / "fixture.json"
        external.write_bytes(self.file.read_bytes())
        external.chmod(0o600)
        initial = external.read_bytes()
        for place in (lambda: self.file.symlink_to(external), lambda: os.link(external, self.file)):
            self.file.unlink()
            place()
            with self.assertRaises((OSError, PartValidationError)):
                store.run("read", {})
            with self.assertRaises((OSError, PartValidationError)):
                self.save(1, [])
            self.assertEqual(external.read_bytes(), initial)

    def test_corrupt_record_and_interrupted_publish_never_replace_current_policy(self):
        self.save()
        original = self.file.read_bytes()
        with patch("character_equipment.os.replace", side_effect=OSError("synthetic publish failure")):
            with self.assertRaises(OSError):
                self.save(1, [])
        self.assertEqual(self.file.read_bytes(), original)
        self.assertEqual(list(self.folder.iterdir()), [self.file])
        for malformed in (b'{"schema":1,"schema":1,"revision":1,"policies":[]}', b"x" * (store.LIMIT + 1)):
            self.file.write_bytes(malformed)
            with self.assertRaises((ValueError, PartValidationError)):
                self.save(1, [])
            self.assertEqual(self.file.read_bytes(), malformed)


if __name__ == "__main__":
    unittest.main()

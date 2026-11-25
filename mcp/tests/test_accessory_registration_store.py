"""S104 filesystem and canonical record tests, using synthetic state only."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import accessory_registration_store as store
from independent_parts import PartValidationError


PROTOCOL = Path(__file__).resolve().parents[2] / "game_runtime/accessory-registration-protocol-v1.json"
NOW = datetime(2026, 11, 24, 12, 34, 56, 789000, tzinfo=timezone.utc)


class RegistrationStoreTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(TemporaryDirectory(prefix="registration-")))
        (self.root / "game_runtime").mkdir()
        shutil.copyfile(PROTOCOL, self.root / "game_runtime" / PROTOCOL.name)
        self.enterContext(patch.object(store, "ROOT", self.root))
        self.enterContext(patch.object(store, "utc_now", return_value=NOW))
        self.folder = self.root / "local_state" / store.FOLDER
        protocol = json.loads(PROTOCOL.read_bytes())
        model = {"fast_window": 3, "slow_window": 9, "risk_fraction": .35,
                 "plugin_weights": {"trend": 100, "momentum": 0, "reversion": 0, "volatility": 0},
                 "plugin_strengths": dict.fromkeys(store.FOCI, 100)}
        self.content = {
            "schema": 1, "registered_jst_day": "2026-11-24", "earliest_possible_day": "2026-11-25",
            "context": {"character_id": "cp_"+"a"*32, "active_revision": 1,
                        "equipment_revision": 2, "expected_revision": 3},
            "source_revisions": dict.fromkeys(store.REVISIONS, 4),
            "base_model": model, "baseline": model,
            "candidate": {**model, "plugin_weights": {"trend": 91, "momentum": 9, "reversion": 0, "volatility": 0}},
            "applied_rules": [{"kind_id": "fixture.pin", "focus": "momentum", "intensity": 1}],
            "visible_kinds": ["fixture.pin"], "source_sha256": dict.fromkeys(protocol["source_files"], "b"*64),
            "protocol": protocol, "timestamp_basis": "local_system_clock", "status": "pending_no_verified_data",
        }
        self.expires = int(NOW.timestamp()*1000) + 60000

    def save(self, content=None, expires=None):
        return store.run("save", {"content": self.content if content is None else content,
                                  "expires_at_ms": self.expires if expires is None else expires})["registration"]

    def test_list_does_not_create_and_saved_record_has_canonical_full_digest(self):
        self.assertEqual(store.run("list", {}), {"registrations": []})
        self.assertFalse(self.folder.parent.exists())
        metadata = self.save()
        path = self.folder / (metadata["id"]+".json")
        raw = path.read_bytes()
        record = json.loads(raw)
        self.assertEqual(raw, store.canonical({**self.content, "created_at": "2026-11-24T12:34:56.789Z"}))
        self.assertEqual(store.digest(raw), metadata["id"])
        self.assertEqual(store.canonical(dict(reversed(list(record.items())))), raw)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.folder.stat().st_mode & 0o777, 0o700)
        self.assertEqual(store.run("list", {}), {"registrations": [metadata]})
        self.assertEqual(set(metadata), {"id","created_at","registered_jst_day","earliest_possible_day","status","timestamp_basis"})
        self.assertEqual(path.read_bytes(), raw)

    def test_strict_schema_and_jst_rollover_fail_before_writing(self):
        for invalid in ({**self.content, "created_at": "2026-11-22T00:00:00.000Z"},
                        {**self.content, "candidate": {**self.content["baseline"], "risk_fraction": float("nan")}},
                        {**self.content, "candidate": {**self.content["baseline"], "fast_window": 4}},
                        {**self.content, "visible_kinds": []}, {**self.content, "source_sha256": {}},
                        {**self.content, "earliest_possible_day": "2026-11-26"},
                        {**self.content, "protocol": {**self.content["protocol"], "codes": []}}):
            with self.assertRaises((ValueError, store.PartsError)):
                self.save(invalid)
        with self.assertRaisesRegex(store.Rejected, "stale"):
            self.save(expires=int(NOW.timestamp()*1000))
        with patch.object(store, "utc_now", return_value=NOW.replace(hour=15, minute=0, second=0)):
            with self.assertRaisesRegex(store.Rejected, "stale"):
                self.save(expires=int((NOW+timedelta(hours=3)).timestamp()*1000))
        self.assertFalse(self.folder.parent.exists())

    def test_duplicate_race_and_same_day_later_timestamp_are_rejected(self):
        def try_save():
            try:
                return self.save()
            except store.Rejected as error:
                return str(error)
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda _: try_save(), range(2)))
        self.assertEqual(outcomes.count("duplicate"), 1)
        expected = next(row for row in outcomes if isinstance(row, dict))
        with patch.object(store, "utc_now", return_value=NOW+timedelta(seconds=1)):
            with self.assertRaisesRegex(store.Rejected, "duplicate"):
                self.save()
        self.assertEqual(store.run("list", {}), {"registrations": [expected]})
        self.assertEqual(len(list(self.folder.iterdir())), 1)

    def test_list_rejects_tampered_bytes_and_wrong_schema_even_with_correct_hash(self):
        result = self.save()
        path = self.folder / (result["id"]+".json")
        raw = path.read_bytes()
        path.write_bytes(raw + b"\n")
        with self.assertRaises(PartValidationError):
            store.run("list", {})
        path.unlink()
        malformed = store.canonical({**json.loads(raw), "trained": True})
        path = self.folder / (store.digest(malformed)+".json")
        path.write_bytes(malformed)
        path.chmod(0o600)
        with self.assertRaises(PartValidationError):
            store.run("list", {})

    def test_directory_symlink_record_symlink_and_hardlink_fail_closed(self):
        other = self.root / "other"
        other.mkdir(mode=0o700)
        self.folder.parent.mkdir(mode=0o700)
        self.folder.symlink_to(other, target_is_directory=True)
        for job in (self.save, lambda: store.run("list", {})):
            with self.assertRaises(OSError):
                job()
        self.assertEqual(list(other.iterdir()), [])
        self.folder.unlink()
        result = self.save()
        record = self.folder / (result["id"]+".json")
        outside = other / "data"
        record.rename(outside)
        record.symlink_to(outside)
        with self.assertRaises(OSError):
            store.run("list", {})
        record.unlink()
        os.link(outside, record)
        with self.assertRaises(PartValidationError):
            store.run("list", {})
        self.assertEqual(outside.stat().st_nlink, 2)

    def test_capacity_and_atomic_no_replace(self):
        first = self.save()
        second = {**self.content, "context": {**self.content["context"], "equipment_revision": 3}}
        with patch.object(store, "CAPACITY", 1):
            with self.assertRaisesRegex(store.Rejected, "full"):
                self.save(second)
            self.assertEqual(store.run("list", {}), {"registrations": [first]})
        path = self.folder / (first["id"]+".json")
        original = path.read_bytes()
        with store.directory(self.folder) as folder:
            with self.assertRaisesRegex(store.Rejected, "duplicate"):
                store.publish(folder, path.name, b"must not replace", [], [], self.content, self.expires)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(list(self.folder.iterdir()), [path])


if __name__ == "__main__":
    unittest.main()

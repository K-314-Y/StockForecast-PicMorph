"""S112 private storage and simulated time ordering tests. No real data."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import synthetic_observation_store as store
from independent_parts import PartValidationError

BEFORE_CORRECTION = "2025-02-04T12:00:00.000Z"
AFTER_CORRECTION = "2025-02-04T23:30:00.000Z"


class SyntheticObservationTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(TemporaryDirectory(prefix="s112-synthetic-")))
        self.folder = self.root / store.FOLDER

    def save(self, variant):
        return store.save_synthetic_snapshot(self.root, variant)

    def test_no_implicit_storage_or_arbitrary_inputs(self):
        for value in ("real", "../prices.json", {"rows": []}):
            with self.assertRaises(PartValidationError):
                self.save(value)
        with self.assertRaises(FileNotFoundError):
            store.load_snapshot(self.root, "0"*64)
        self.assertFalse(self.folder.exists())

    def test_original_correction_and_late_version_are_separate(self):
        original = self.save("original")
        path = self.folder / (original+".json")
        first = path.read_bytes()
        info = path.stat()
        corrected = self.save("corrected")
        late = self.save("late")
        self.assertEqual(len({original, corrected, late}), 3)
        self.assertEqual(len(list(self.folder.iterdir())), 3)
        self.assertEqual(path.read_bytes(), first)
        self.assertEqual(self.save("original"), original)
        self.assertEqual(path.stat().st_ino, info.st_ino)
        self.assertEqual(path.stat().st_mtime_ns, info.st_mtime_ns)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.folder.stat().st_mode & 0o777, 0o700)
        a = store.load_snapshot(self.root, original)
        b = store.load_snapshot(self.root, corrected)
        self.assertNotEqual(a["source_payload_sha256"], b["source_payload_sha256"])
        self.assertEqual(set(a["rows"]), set(store.CODES))
        self.assertEqual(sum(len(rows) for rows in a["rows"].values()), 240)
        self.assertTrue(all([r["date"] for r in rows] == a["history_sessions"]
                            for rows in a["rows"].values()))
        self.assertTrue(all(a[key] is False for key in
            ("real_market_history", "source_verified", "score_allowed", "holdout_evaluated")))

    def test_explicit_pinned_id_and_no_future_version(self):
        a = self.save("original")
        b = self.save("corrected")
        c = self.save("late")
        self.assertEqual(store.load_for_decision(self.root, a, BEFORE_CORRECTION)["scenario"], "original")
        with self.assertRaises(PartValidationError):
            store.load_for_decision(self.root, b, BEFORE_CORRECTION)
        self.assertEqual(store.load_for_decision(self.root, b, AFTER_CORRECTION)["scenario"], "corrected")
        self.assertEqual(store.load_for_decision(self.root, a, AFTER_CORRECTION)["scenario"], "original")
        for moment in (AFTER_CORRECTION, store.OPEN_AT, "2025-02-05T00:02:00.000Z"):
            with self.assertRaises(PartValidationError):
                store.load_for_decision(self.root, c, moment)
        with self.assertRaises(PartValidationError):
            store.load_for_decision(self.root, a, store.OPEN_AT)
        with self.assertRaises(FileNotFoundError):
            store.load_for_decision(self.root, "0"*64, BEFORE_CORRECTION)

    def test_modified_payload_rejected_even_if_renamed_with_new_hash(self):
        identifier = self.save("original")
        path = self.folder / (identifier+".json")
        record = store.load_snapshot(self.root, identifier)
        record["rows"][store.CODES[0]][0]["close_cents"] += 1
        record["source_payload_sha256"] = store.digest(store.canonical(record["rows"]))
        raw = store.canonical(record)
        path.write_bytes(raw)
        with self.assertRaises(PartValidationError):
            store.load_snapshot(self.root, identifier)
        with self.assertRaises(PartValidationError):
            self.save("original")
        other = store.digest(raw)
        target = self.folder / (other+".json")
        path.rename(target)
        with self.assertRaises(PartValidationError):
            store.load_snapshot(self.root, other)

    def test_unsafe_paths_and_permissions_rejected(self):
        identifier = self.save("original")
        path = self.folder / (identifier+".json")
        path.chmod(0o644)
        with self.assertRaises(PartValidationError):
            store.load_snapshot(self.root, identifier)
        path.chmod(0o600)
        target = self.root / "synthetic-backup.json"
        path.rename(target)
        path.symlink_to(target)
        with self.assertRaises(OSError):
            store.load_snapshot(self.root, identifier)
        path.unlink()
        target.rename(path)
        with self.assertRaises(PartValidationError):
            store.load_snapshot(self.root, "../"+identifier)
        self.folder.rename(self.root / "moved")
        self.folder.symlink_to(self.root / "moved", target_is_directory=True)
        with self.assertRaises(OSError):
            self.save("corrected")

    def test_concurrent_identical_capture_never_replaces_published_version(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            ids = list(pool.map(self.save, ["original"]*8))
        self.assertEqual(len(set(ids)), 1)
        self.assertEqual([p.name for p in self.folder.iterdir()], [ids[0]+".json"])
        self.assertEqual(store.load_snapshot(self.root, ids[0]), store.synthetic_snapshot("original"))


if __name__ == "__main__":
    unittest.main()

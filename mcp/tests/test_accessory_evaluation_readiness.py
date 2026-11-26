"""Offline evidence-format and filesystem tests, using only synthetic archives."""
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import accessory_evaluation_readiness as readiness
from accessory_registration_store import canonical, REVISIONS
from independent_parts import PartValidationError


PROJECT = Path(__file__).resolve().parents[2]
PROTOCOL_PATH = "game_runtime/accessory-registration-protocol-v1.json"
NOW = datetime(2025, 4, 1, tzinfo=timezone.utc)


def private_write(path, data):
    path.write_bytes(data if isinstance(data, bytes) else canonical(data))
    path.chmod(0o600)


def fixture(root):
    """Seed a canonical synthetic record directly. Never invoke registration or use market data."""
    origin = (PROJECT / PROTOCOL_PATH).read_bytes()
    protocol = json.loads(origin)
    fingerprints = {}
    for name in protocol["source_files"]:
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        code = origin if name == PROTOCOL_PATH else ("synthetic:" + name).encode()
        target.write_bytes(code)
        fingerprints[name] = readiness.digest(code)
    weights = {"trend": 100, "momentum": 0, "reversion": 0, "volatility": 0}
    model = {"fast_window": 3, "slow_window": 9, "risk_fraction": .35,
             "plugin_weights": weights, "plugin_strengths": dict.fromkeys(weights, 100)}
    record = {
        "schema": 1, "registered_jst_day": "2025-02-04", "earliest_possible_day": "2025-02-05",
        "created_at": "2025-02-04T01:02:03.004Z", "context": {"character_id": "cp_"+"a"*32,
            "active_revision": 1, "equipment_revision": 2, "expected_revision": 3},
        "source_revisions": dict.fromkeys(REVISIONS, 1), "protocol": protocol, "source_sha256": fingerprints,
        "base_model": model, "baseline": model, "candidate": model,
        "applied_rules": [{"kind_id": "fixture.pin", "focus": "trend", "intensity": 1}],
        "visible_kinds": ["fixture.pin"], "timestamp_basis": "local_system_clock", "status": "pending_no_verified_data",
    }
    identifier = readiness.digest(canonical(record))
    registrations = root / "local_state" / readiness.FOLDER
    registrations.mkdir(mode=0o700, parents=True)
    private_write(registrations / (identifier+".json"), record)

    cutoff = date.fromisoformat(record["registered_jst_day"])
    offsets = (cutoff + timedelta(days=i) for i in range(-50, 30))
    weekdays = [day for day in offsets if day.weekday() < 5]
    history = [day for day in weekdays if day <= cutoff][-24:]
    future = [day for day in weekdays if day > cutoff][:12]
    dates = [day.isoformat() for day in history+future]
    package = {"schema": 1, "registration_id": identifier,
        "source":{"type":readiness.SOURCE_TYPE,"id":"synthetic_jpx","retrieved_at":"2025-03-01T12:00:00.000Z"},
        "evidence": {key:{"ref":"fixture-"+key,"sha256":"a"*64} for key in readiness.EVIDENCE},
        "calendar":{"coverage_start":dates[0],"coverage_end":dates[-1],"registration_jst_day":cutoff.isoformat(),
                    "sessions":[{"date":day,"close_at":day+"T06:30:00.000Z"} for day in dates]},
        "rows":{code:[{"date":day,"adjusted_close":100+i,"available_at":day+"T06:35:00.000Z",
                       "observed_at":day+"T08:00:00.000Z"} for i,day in enumerate(dates)]
                for code in protocol["codes"]}}
    return identifier, record, package


class EvaluationReadinessTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(TemporaryDirectory(prefix="eval-readiness-")))
        self.id, self.record, self.package = fixture(self.root)
        self.state = self.root / "local_state"
        self.folder = self.state / readiness.INPUT_FOLDER
        self.file = self.folder / (self.id+".json")
        self.record_file = self.state / readiness.FOLDER / self.file.name

    def inspect(self):
        result = readiness.inspect(self.id, root=self.root, now=NOW)
        for key in ("score_allowed", "holdout_evaluated", "calendar_verified", "source_verified", "rights_verified",
                    "point_in_time_verified", "adjustments_verified", "timestamps_verified"):
            self.assertIs(result[key], False)
        return result

    def put(self, data=None):
        self.folder.mkdir(mode=0o700, exist_ok=True)
        private_write(self.file, self.package if data is None else data)

    def test_missing_input_never_creates_or_reads_source_files(self):
        with patch.object(readiness, "fingerprints_match", side_effect=AssertionError("read code without input")):
            self.assertEqual(self.inspect()["status"], "pending_input")
            self.assertFalse(self.folder.exists())
            self.folder.mkdir(mode=0o700)
            private_write(self.folder / ("0"*64+".json"), b"not this registration")
            self.assertEqual(self.inspect()["status"], "pending_input")
        self.assertEqual(len(list(self.folder.iterdir())), 1)

    def test_matching_structure_remains_pending_and_keeps_large_moves(self):
        self.package["rows"]["40050"][-1]["adjusted_close"] = 1e150
        self.put()
        before = self.file.read_bytes()
        result = self.inspect()
        self.assertEqual(result["status"], "pending_evidence_review")
        counts = result["actual"]
        self.assertEqual((counts["codes"], counts["history_sessions"], counts["evaluation_sessions"], counts["rows"]),
                         (10, 24, 12, 360))
        self.assertEqual(counts["evaluation_first"], "2025-02-05")
        self.assertGreater(self.package["rows"]["40050"][-1]["observed_at"], self.record["created_at"])
        self.assertNotIn("1e+150", json.dumps(result))
        self.assertNotIn("fixture-rights", json.dumps(result))
        self.assertEqual(self.file.read_bytes(), before)

    def test_stale_fingerprint_in_every_v1_source_including_protocol(self):
        self.put()
        for name in self.record["source_sha256"]:
            path = self.root / name
            original = path.read_bytes()
            path.write_bytes(b"different")
            with self.subTest(name=name):
                self.assertEqual(self.inspect()["status"], "pending_code_mismatch")
            path.write_bytes(original)

    def test_unreadable_code_is_not_a_computed_fingerprint_mismatch(self):
        self.put()
        source = self.root / "engine.py"
        original = source.read_bytes()
        source.unlink()
        with self.assertRaises(OSError):
            self.inspect()
        source.write_bytes(original)
        with patch.object(readiness, "read_file", side_effect=PermissionError("synthetic")):
            with self.assertRaises(PermissionError):
                self.inspect()
        self.assertEqual(self.inspect()["status"], "pending_evidence_review")

    def test_missing_or_corrupt_record_fails_even_before_input(self):
        self.put()
        self.record_file.unlink()
        with self.assertRaises(readiness.RecordNotFound):
            self.inspect()
        private_write(self.record_file, {**self.record, "status": "fake"})
        with self.assertRaises(PartValidationError):
            self.inspect()

    def test_manifest_binding_flags_and_retrospective_source_fail_closed(self):
        for key,value,reason in [
            ("registration_id", "0"*64, "registration_binding"),
            ("schema", True, "manifest_shape"),
            ("score_allowed", True, "manifest_shape"),
            ("source", {**self.package["source"],"type":"LOCAL_PRIVATE_JQUANTS_ADJUSTED_RESEARCH"}, "source_evidence"),
            ("evidence", {**self.package["evidence"],"rights":{"ref":"../not-allowed","sha256":"a"*64}}, "source_evidence"),
            ("evidence", {k:v for k,v in self.package["evidence"].items() if k!="point_in_time"}, "source_evidence"),
        ]:
            self.put({**self.package, key:value})
            with self.subTest(key=key,value=value):
                self.assertEqual(self.inspect()["reason"], reason)
        self.put(canonical(self.package).replace(b'"schema":1', b'"schema":1,"schema":1'))
        self.assertEqual(self.inspect()["reason"], "manifest_shape")
        self.put(b"\xff")
        self.assertEqual(self.inspect()["reason"], "manifest_shape")

    def test_codes_rows_and_prices_are_exact_and_finite(self):
        for mutation in (
            lambda p:p["rows"].pop("40050"),
            lambda p:p["rows"].update({"00000":p["rows"]["40050"]}),
            lambda p:p["rows"]["40050"].pop(),
            lambda p:p["rows"]["40050"][0].update(date=p["rows"]["40050"][1]["date"]),
            lambda p:p["rows"]["40050"][0].update(adjusted_close=True),
            lambda p:p["rows"]["40050"][0].update(adjusted_close=0),
        ):
            data = deepcopy(self.package)
            mutation(data)
            self.put(data)
            self.assertEqual(self.inspect()["reason"], "row_alignment")
        self.put(canonical(self.package).replace(b'"adjusted_close":100', b'"adjusted_close":1e999', 1))
        self.assertEqual(self.inspect()["reason"], "row_alignment")

    def test_calendar_dates_weekends_and_registration_boundary(self):
        for mutation in (
            lambda c:c["sessions"].pop(),
            lambda c:c["sessions"][1].update(date=c["sessions"][0]["date"]),
            lambda c:c["sessions"][0].update(date="2025-02-31"),
            lambda c:c["sessions"][0].update(date="2025-01-04"),
            lambda c:c.update(coverage_end=c["sessions"][-2]["date"]),
            lambda c:c.update(registration_jst_day="2025-02-05"),
            lambda c:c["sessions"][24].update(date=c["sessions"][23]["date"]),
        ):
            data = deepcopy(self.package)
            mutation(data["calendar"])
            self.put(data)
            self.assertEqual(self.inspect()["reason"], "calendar_structure")
        # Skip a declared weekday without pretending to know whether it was a holiday.
        data = deepcopy(self.package)
        dates = data["calendar"]["sessions"]
        last = date.fromisoformat(dates[-1]["date"])
        suffix = []
        while len(suffix)<2:
            last += timedelta(days=1)
            if last.weekday()<5:
                suffix.append(last.isoformat())
        dates[-1] = {"date": suffix[1], "close_at": suffix[1]+"T06:30:00.000Z"}
        data["calendar"]["coverage_end"] = suffix[1]
        for rows in data["rows"].values():
            rows[-1].update(date=suffix[1],available_at=suffix[1]+"T06:35:00.000Z",observed_at=suffix[1]+"T07:00:00.000Z")
        self.put(data)
        self.assertEqual(self.inspect()["status"], "pending_evidence_review")

    def test_utc_observation_availability_retrieval_and_close_order(self):
        for mutation in (
            lambda p:p["source"].update(retrieved_at="2025-04-02T00:00:00.000Z"),
            lambda p:p["rows"]["40050"][0].update(observed_at="2025-04-01T00:00:00.000Z"),
            lambda p:p["rows"]["40050"][0].update(observed_at=p["rows"]["40050"][0]["date"]+"T06:31:00.000Z"),
            lambda p:p["rows"]["40050"][0].update(available_at=p["rows"]["40050"][0]["date"]+"T06:20:00.000Z"),
            lambda p:p["calendar"]["sessions"][0].update(close_at=p["rows"]["40050"][0]["date"]+"T07:00:00.000Z"),
            lambda p:p["calendar"]["sessions"][0].update(close_at=p["rows"]["40050"][0]["date"]+"T06:00:00.000Z"),
            lambda p:p["rows"]["40050"][0].update(available_at=p["rows"]["40050"][0]["date"]+"T15:30:00+09:00"),
        ):
            data = deepcopy(self.package)
            mutation(data)
            self.put(data)
            self.assertEqual(self.inspect()["reason"], "timestamp_structure")

    def test_privacy_and_512_kib_bound(self):
        self.put()
        original = self.root / "isolated.json"
        self.file.rename(original)
        self.file.symlink_to(original)
        self.assertEqual(self.inspect()["reason"], "unsafe_input")
        self.file.unlink()
        os.link(original, self.file)
        self.assertEqual(self.inspect()["reason"], "unsafe_input")
        self.file.unlink()
        self.put(b"x"*(readiness.INPUT_LIMIT+1))
        self.assertEqual(self.inspect()["reason"], "unsafe_input")
        self.put()
        self.file.chmod(0o644)
        self.assertEqual(self.inspect()["reason"], "unsafe_input")
        self.file.unlink()
        self.folder.rmdir()
        self.folder.symlink_to(self.root, target_is_directory=True)
        self.assertEqual(self.inspect()["reason"], "unsafe_input")


class EvidenceAttachmentTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(TemporaryDirectory(prefix="eval-evidence-")))
        self.id, self.record, self.package = fixture(self.root)
        self.state = self.root / "local_state"
        self.inputs = self.state / readiness.INPUT_FOLDER
        self.inputs.mkdir(mode=0o700)
        self.input = self.inputs / (self.id + ".json")
        self.collection = self.state / readiness.EVIDENCE_FOLDER
        self.folder = self.collection / self.id

    def put(self):
        private_write(self.input, self.package)

    def audit(self):
        result = readiness.inspect(self.id, root=self.root, now=NOW, audit=True)
        for flag in ("score_allowed", "holdout_evaluated", "calendar_verified", "source_verified",
                     "rights_verified", "point_in_time_verified", "adjustments_verified", "timestamps_verified"):
            self.assertIs(result[flag], False)
        return result

    def attach(self, key, raw):
        self.collection.mkdir(mode=0o700, exist_ok=True)
        self.folder.mkdir(mode=0o700, exist_ok=True)
        self.package["evidence"][key]["sha256"] = readiness.digest(raw)
        private_write(self.folder / (key + ".bin"), raw)
        self.put()

    def test_missing_attachments_and_default_readiness_are_read_only(self):
        self.put()
        normal = readiness.inspect(self.id, root=self.root, now=NOW)
        self.assertNotIn("evidence_audit", normal)
        report = self.audit()
        self.assertEqual(report["status"], "pending_evidence_review")
        audit = report["evidence_audit"]
        self.assertEqual(audit["categories"], dict.fromkeys(readiness.EVIDENCE, "missing"))
        self.assertEqual((audit["hash_matches"], audit["expected"]), (0, 6))
        self.assertFalse(self.collection.exists())

    def test_all_six_matching_files_do_not_grant_approval(self):
        for category in readiness.EVIDENCE:
            self.attach(category, ("fictional private proof for " + category).encode())
        original = {p.name: p.read_bytes() for p in self.folder.iterdir()}
        report = self.audit()
        audit = report["evidence_audit"]
        self.assertEqual(audit["categories"], dict.fromkeys(readiness.EVIDENCE, "hash_match"))
        self.assertEqual(audit["hash_matches"], 6)
        self.assertIs(audit["content_reviewed"], False)
        self.assertIs(audit["authenticity_verified"], False)
        self.assertEqual(report["status"], "pending_evidence_review")
        serialized = json.dumps(report)
        self.assertNotIn("fictional private proof", serialized)
        self.assertNotIn("fixture-rights", serialized)
        self.assertNotIn(self.package["evidence"]["rights"]["sha256"], serialized)
        self.assertEqual({p.name: p.read_bytes() for p in self.folder.iterdir()}, original)

    def test_mismatch_and_file_privacy_fail_closed(self):
        self.attach("rights", b"expected")
        private_write(self.folder / "rights.bin", b"changed")
        self.attach("source", b"source")
        (self.folder / "source.bin").chmod(0o644)
        self.attach("calendar", b"calendar")
        (self.folder / "calendar.bin").unlink()
        (self.folder / "calendar.bin").symlink_to(self.input)
        self.attach("retrieval", b"retrieval")
        (self.folder / "retrieval.bin").unlink()
        private_write(self.root / "synthetic-attachment.bin", b"retrieval")
        os.link(self.root / "synthetic-attachment.bin", self.folder / "retrieval.bin")
        self.attach("point_in_time", b"oversize")
        private_write(self.folder / "point_in_time.bin", b"x" * (readiness.EVIDENCE_LIMIT + 1))
        audit = self.audit()["evidence_audit"]
        self.assertEqual(audit["categories"], {"rights":"hash_mismatch", "source":"unsafe",
            "calendar":"unsafe", "retrieval":"unsafe", "point_in_time":"unsafe", "adjustment":"missing"})
        self.assertEqual(audit["hash_matches"], 0)

    def test_reference_is_not_path_and_other_registration_is_not_read(self):
        self.attach("rights", b"expected")
        (self.folder / "rights.bin").unlink()
        ref = self.package["evidence"]["rights"]["ref"]
        private_write(self.folder / ref, b"expected")
        other = self.collection / ("0"*64)
        other.mkdir(mode=0o700)
        private_write(other / "rights.bin", b"expected")
        self.assertEqual(self.audit()["evidence_audit"]["categories"]["rights"], "missing")

    def test_invalid_package_or_changed_code_never_reads_evidence(self):
        with patch.object(readiness, "audit_evidence", side_effect=AssertionError("unexpected audit")):
            self.assertIsNone(self.audit()["evidence_audit"])
            self.package["rows"].pop("40050")
            self.put()
            self.assertEqual(self.audit()["status"], "pending_invalid_input")
            self.assertIsNone(self.audit()["evidence_audit"])
            (self.root / "engine.py").write_bytes(b"changed")
            self.assertEqual(self.audit()["status"], "pending_code_mismatch")
            self.assertIsNone(self.audit()["evidence_audit"])

    def test_symlink_directory_and_changed_attachment_fail_closed(self):
        self.put()
        self.collection.symlink_to(self.root, target_is_directory=True)
        self.assertEqual(self.audit()["evidence_audit"]["categories"],
                         dict.fromkeys(readiness.EVIDENCE, "unsafe"))
        self.collection.unlink()
        self.attach("rights", b"original")
        original = readiness.recheck
        def change(paths, snapshots):
            if any(name == "rights.bin" for _, name, _ in snapshots):
                private_write(self.folder / "rights.bin", b"changed after read")
            return original(paths, snapshots)
        with patch.object(readiness, "recheck", side_effect=change):
            with self.assertRaises(PartValidationError):
                self.audit()


if __name__ == "__main__":
    unittest.main()

"""Synthetic private archives for the S103 manifest and chronology contract."""
import io
import json
import os
import sys
import unittest
from datetime import date, timedelta
from hashlib import sha256
from pathlib import Path
from subprocess import run
from tempfile import TemporaryDirectory
from unittest.mock import patch

from game_runtime import adjusted_split_bridge as bridge


def calendar_fixture():
    first, last = date.fromisoformat(bridge.FIRST), date.fromisoformat(bridge.LAST)
    dates = [first + timedelta(days=i) for i in range((last - first).days + 1)]
    weekdays = [day.isoformat() for day in dates if day.weekday() < 5]
    return [weekdays[i * (len(weekdays) - 1) // (bridge.ROW_COUNT - 1)] for i in range(bridge.ROW_COUNT)]


def model():
    keys = ("trend", "momentum", "reversion", "volatility")
    return {"fast_window": 4, "slow_window": 10, "risk_fraction": .35,
            "plugin_weights": dict(zip(keys, (40, 20, 25, 15))),
            "plugin_strengths": dict.fromkeys(keys, 100)}


class AdjustedSplitTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(TemporaryDirectory(prefix="adjusted-split-")))
        self.calendar = calendar_fixture()
        self.folders = {}
        for name, files in bridge.SHARDS.items():
            folder = self.root / name
            folder.mkdir(mode=0o700)
            manifest = {"status": bridge.STATUS, "missing_sessions": bridge.MISSING, "files": {},
                        "usage": "USER_OWN_PRIVATE_RESEARCH_ONLY",
                        "source_api": "https://api.jquants.com/v2/equities/bars/daily",
                        "timestamp_basis": "RETRIEVAL_NOT_POINT_IN_TIME", "corporate_action_status": "UNVERIFIED",
                        **dict.fromkeys(bridge.FALSE_FLAGS, False)}
            params = {"from": bridge.FIRST, "to": bridge.LAST}
            if len(files) == 1:
                params["code"] = "94320"
                manifest.update(row_count=485, original_row_count=487)
            else:
                manifest.update(codes=sorted(files.values()), row_count_per_code=485,
                                original_row_count_per_code=487, total_row_count=485 * len(files))
            manifest["parameters"] = params
            for filename, code in files.items():
                rows = [{"Code": code, "Date": day, "AdjC": 100+i*.05, "AdjFactor": 1}
                        for i, day in enumerate(self.calendar)]
                rows[30].update(AdjC=500, AdjFactor=.5)
                path = folder / filename
                raw = self.write(path, rows)
                manifest["files"][filename] = sha256(raw).hexdigest()
                self.folders[code] = (folder, path)
            self.write(folder / "manifest.json", manifest)
        self.folder, self.path = self.folders["94320"]
        self.manifest = self.folder / "manifest.json"

    @staticmethod
    def write(path, obj):
        raw = json.dumps(obj).encode()
        path.write_bytes(raw)
        path.chmod(0o600)
        return raw

    def rewrite_rows(self, rows):
        raw = self.write(self.path, rows)
        manifest = json.loads(self.manifest.read_bytes())
        manifest["files"][self.path.name] = sha256(raw).hexdigest()
        self.write(self.manifest, manifest)

    def test_full_private_archive_and_fixed_whole_windows_are_read_only(self):
        before = {p: p.read_bytes() for p in self.root.glob("*/*.json")}
        calendar, series = bridge.load_adjusted(self.root)
        self.assertEqual(calendar, self.calendar)
        self.assertEqual(sorted(series), list(bridge.CODES))
        self.assertEqual(series["94320"][30], (self.calendar[30], 500))
        schedule = bridge.select_windows(calendar)
        self.assertEqual(schedule["early"][0], (0, 36))
        data = {"base_model": model(), "models": dict.fromkeys(("mine", "owl", "turtle"), model())}
        with patch.object(bridge, "load_adjusted", return_value=(calendar, series)):
            report = bridge.evaluate(data)
        self.assertEqual(set(report["phases"]), {"early", "later"})
        self.assertFalse(report["flags"]["pit_verified"])
        self.assertTrue(report["manifests_verified"])
        self.assertEqual(report["missing_sessions"], ["2024-08-01", "2024-08-02"])
        for phase, rows in report["phases"].items():
            self.assertEqual(len(rows), len(schedule[phase])*10)
            for start, stop in schedule[phase]:
                self.assertEqual(stop-start, 36)
                self.assertEqual(calendar[start] < bridge.CUTOFF, phase == "early")
                self.assertEqual(calendar[stop-1] < bridge.CUTOFF, phase == "early")
            for code in bridge.CODES:
                chronological = [r for r in rows if r["code"] == code]
                self.assertEqual(len(chronological), len(schedule[phase]))
                self.assertTrue(all(a["end_date"] < b["start_date"] for a,b in zip(chronological, chronological[1:])))
            self.assertTrue(all(row["brier"]["mine"] == row["brier"]["owl"] for row in rows))
        self.assertEqual({p: p.read_bytes() for p in self.root.glob("*/*.json")}, before)

    def test_spikes_and_split_factors_are_not_selection_inputs(self):
        calendar, series = bridge.load_adjusted(self.root)
        data = {"base_model": model(), "models": dict.fromkeys(("mine", "owl", "turtle"), model())}
        with patch.object(bridge, "load_adjusted", return_value=(calendar, series)):
            before = bridge.evaluate(data)
        rows = json.loads(self.path.read_bytes())
        rows[30]["AdjC"], rows[30]["AdjFactor"] = .5, 2
        self.rewrite_rows(rows)
        calendar, series = bridge.load_adjusted(self.root)
        with patch.object(bridge, "load_adjusted", return_value=(calendar, series)):
            after = bridge.evaluate(data)
        for phase in before["phases"]:
            self.assertEqual([row["market_id"] for row in before["phases"][phase]],
                             [row["market_id"] for row in after["phases"][phase]])

    def test_long_gap_uses_first_session_after_gap_without_crossing_cutoff(self):
        days = [(date(2024, 8, 5)+timedelta(days=i+(11 if i>20 else 0))).isoformat() for i in range(75)]
        days += [(date(2025, 8, 1)+timedelta(days=i)).isoformat() for i in range(80)]
        windows = bridge.select_windows(days)
        self.assertEqual(windows["early"], [(21, 57)])
        self.assertEqual(windows["later"], [(75, 111), (111, 147)])

    def test_hash_mismatch_or_missing_file_fails(self):
        self.path.write_bytes(self.path.read_bytes()+b" ")
        with self.assertRaisesRegex(ValueError, "SHA"):
            bridge.load_adjusted(self.root)
        self.path.unlink()
        with self.assertRaises(FileNotFoundError):
            bridge.load_adjusted(self.root)

    def test_hardlink_symlink_and_non_private_entries_fail(self):
        source = self.root / "external.json"
        source.write_bytes(self.path.read_bytes())
        source.chmod(0o600)
        self.path.unlink()
        os.link(source, self.path)
        with self.assertRaisesRegex(ValueError, "unsafe archive file"):
            bridge.load_adjusted(self.root)
        self.path.unlink()
        self.path.symlink_to(source)
        with self.assertRaises(OSError):
            bridge.load_adjusted(self.root)
        self.path.unlink()
        self.path.write_bytes(source.read_bytes())
        self.path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "unsafe archive file"):
            bridge.load_adjusted(self.root)
        alias = self.root / "symlink-root"
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            bridge.load_adjusted(alias)

    def test_manifests_require_original_provenance_counts_and_false_flags(self):
        initial = json.loads(self.manifest.read_bytes())
        for key, replacement in (("row_count", 484), ("rights_verified", True), ("rights_verified", None),
                                 ("license_verified", 0), ("pit_verified", True), ("training_eligible", True),
                                 ("source_api", "unknown"), ("status", "FORWARD"),
                                 ("files", {"../foreign.json": "0"*64})):
            with self.subTest(key=key, replacement=replacement):
                manifest = dict(initial)
                if replacement is None:
                    manifest.pop(key)
                else:
                    manifest[key] = replacement
                self.write(self.manifest, manifest)
                with self.assertRaises(ValueError):
                    bridge.load_adjusted(self.root)

    def test_invalid_rows_fail_even_with_correct_manifest_digest(self):
        raw = json.loads(self.path.read_bytes())
        for row in ({**raw[1], "Code": "40050"}, {**raw[1], "Date": raw[0]["Date"]},
                    {**raw[1], "Date": "2024-08-33"}, {**raw[1], "AdjC": True},
                    {**raw[1], "AdjC": 0}, {**raw[1], "AdjC": float("inf")},
                    {**raw[1], "AdjFactor": None}):
            self.rewrite_rows([raw[0], row, *raw[2:]])
            with self.assertRaises(ValueError):
                bridge.load_adjusted(self.root)
        self.rewrite_rows(raw[:-1])
        with self.assertRaisesRegex(ValueError, "session count"):
            bridge.load_adjusted(self.root)

    def test_no_network_module_and_no_path_or_unbounded_io(self):
        # The dedicated bridge depends on pure inference, not the old acquisition module.
        run([sys.executable, "-B", "-E", "-S", "-c", """
import sys
from game_runtime import adjusted_split_bridge
assert all(name not in sys.modules for name in ('market_bridge', 'game_runtime.market_bridge', 'urllib.request'))
"""], check=True)
        data = {"base_model": model(), "models": dict.fromkeys(("mine","owl","turtle"), model())}
        with patch.object(bridge, "load_adjusted", side_effect=AssertionError("invalid input touched archive")):
            with self.assertRaises(ValueError):
                bridge.evaluate({**data, "path": str(self.root)})
        output = io.BytesIO()
        with self.assertRaisesRegex(ValueError, "input limit"):
            bridge.main(io.BytesIO(b" "*(bridge.MAX_INPUT+1)), output)
        with patch.object(bridge, "evaluate", return_value={"large": "あ"*180000}):
            with self.assertRaisesRegex(ValueError, "output limit"):
                bridge.main(io.BytesIO(b"{}"), output)
        self.assertEqual(output.getvalue(), b"")


if __name__ == "__main__":
    unittest.main()

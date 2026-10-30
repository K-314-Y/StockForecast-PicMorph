"""V6-inspired immutable record contracts using ONLY synthetic local fixtures."""
import hashlib
import json
import math
import tempfile
import unittest
from pathlib import Path

from forward_journal import JournalError, freeze_offline, settle_offline

HISTORY_HASH = hashlib.sha256(b"synthetic-history-prefix").hexdigest()
MODEL_HASH = hashlib.sha256(b"synthetic-model-version").hexdigest()
OUTCOME_HASH = hashlib.sha256(b"synthetic-outcome").hexdigest()


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Path(self.temp.name) / "creature-journal"
        self.forecast = dict(
            run_id="demo-one", as_of_session="2026-10-29",
            target_session="2026-10-30",
            calendar=["2026-10-28", "2026-10-29", "2026-10-30"],
            generated_at="2026-10-31T03:15:00+09:00",
            input_available_at="2026-10-31T03:14:59+09:00",
            input_sha256=HISTORY_HASH, model_sha256=MODEL_HASH,
            probabilities={"UP": 0.7, "FLAT": 0.2, "DOWN": 0.1}
        )
        self.outcome = dict(
            run_id="demo-one", target_session="2026-10-30",
            actual="DOWN", outcome_available_at="2026-10-31T03:16:00+09:00",
            outcome_sha256=OUTCOME_HASH
        )

    def test_freeze_and_one_time_scoring(self):
        frozen = freeze_offline(self.store, **self.forecast)
        self.assertEqual(frozen["record"]["mode"], "OFFLINE_REPLAY_ONLY")
        self.assertFalse(frozen["record"]["forward_eligible"])
        self.assertEqual(freeze_offline(self.store, **self.forecast), frozen)
        evaluated = settle_offline(self.store, **self.outcome)
        self.assertEqual(evaluated["record"]["brier"], 1.34)
        self.assertEqual(evaluated["record"]["uniform_brier"], round(2 / 3, 9))
        self.assertEqual(evaluated["record"]["forecast_sha256"], frozen["sha256"])
        self.assertEqual(settle_offline(self.store, **self.outcome), evaluated)
        with self.assertRaisesRegex(JournalError, "上書き"):
            freeze_offline(self.store, **(self.forecast | {"model_sha256": OUTCOME_HASH}))
        with self.assertRaisesRegex(JournalError, "上書き"):
            settle_offline(self.store, **(self.outcome | {"actual": "UP"}))
        self.assertEqual(len(list(self.store.glob("*.json"))), 2)

    def test_next_session_calendar_must_be_explicit(self):
        for bad in (["2026-10-29", "2026-10-31"],
                    ["2026-10-29", "2026-10-30", "2026-10-30"],
                    ["2026-10-30", "2026-10-29"]):
            with self.assertRaises(JournalError):
                freeze_offline(self.store, **(self.forecast | {"calendar": bad}))
        self.assertFalse(self.store.exists())

    def test_no_late_inputs_and_timezones_required(self):
        for bad in (
            {"input_available_at": "2026-10-31T03:16:00+09:00"},
            {"input_available_at": "2026-10-31T03:14:00"},
            {"generated_at": "not-datetime"},
            {"probabilities": {"UP": 1.0, "FLAT": 0.0, "DOWN": float("nan")}},
            {"probabilities": {"UP": True, "FLAT": 0, "DOWN": 0}},
            {"probabilities": {"UP": .6, "FLAT": .3, "DOWN": .3}},
            {"model_sha256": "../some-other-project"},
            {"run_id": "../v6"},
        ):
            with self.subTest(bad=bad), self.assertRaises(JournalError):
                freeze_offline(self.store, **(self.forecast | bad))
        self.assertEqual(list(self.store.glob("*.json")) if self.store.exists() else [], [])

    def test_requires_prior_forecast_and_later_outcome(self):
        with self.assertRaises(FileNotFoundError):
            settle_offline(self.store, **self.outcome)
        freeze_offline(self.store, **self.forecast)
        with self.assertRaisesRegex(JournalError, "予測が作られる前"):
            settle_offline(self.store, **(self.outcome |
                {"outcome_available_at": "2026-10-31T03:14:00+09:00"}))
        self.assertFalse((self.store / "demo-one--2026-10-30.outcome.json").exists())

    def test_checksum_detects_after_the_fact_changes(self):
        freeze_offline(self.store, **self.forecast)
        file = self.store / "demo-one--2026-10-30.forecast.json"
        body = json.loads(file.read_text())
        body["record"]["probabilities"]["UP"] = 0.9
        file.write_text(json.dumps(body))
        with self.assertRaisesRegex(JournalError, "検証"):
            settle_offline(self.store, **self.outcome)

    def test_no_automatic_xp_or_v6_access(self):
        freeze_offline(self.store, **self.forecast)
        settle_offline(self.store, **self.outcome)
        self.assertEqual(sorted(p.name for p in self.store.iterdir()),
                         [".lock", "demo-one--2026-10-30.forecast.json",
                          "demo-one--2026-10-30.outcome.json"])
        from forward_journal import MODE
        self.assertEqual(MODE, "OFFLINE_REPLAY_ONLY")


if __name__ == "__main__":
    unittest.main()

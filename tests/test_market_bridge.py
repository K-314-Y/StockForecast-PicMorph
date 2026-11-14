"""Market replay: deterministic replay, no look-ahead, unadjusted warning."""
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch, Mock
from datetime import date, timedelta

from game_runtime.market_bridge import (
    CODES, checked_rows, candidate_windows, generate, load_local,
    sample_window, fetch_jquants, load_jquants_key,
)


def simple_model(risk=.35):
    return {
        "fast_window": 3, "slow_window": 9, "risk_fraction": risk,
        "plugin_weights": {"trend": 100, "momentum": 0,
                           "volatility": 0, "reversion": 0},
        "plugin_strengths": {k: 100 for k in
                             ("trend", "momentum", "volatility", "reversion")},
    }


class HistoricalMarketTests(unittest.TestCase):
    def setUp(self):
        # All forecast fixtures must be offline even when V7 has a live key.
        setting = patch.dict(os.environ, {"CREATURE_MARKET_SOURCE": "local"})
        setting.start()
        self.addCleanup(setting.stop)

    def test_credential_override_never_needs_v7_file(self):
        with patch.dict(os.environ, {"CREATURE_JQUANTS_API_KEY": "dummy-test-key"}):
            self.assertEqual(load_jquants_key(), "dummy-test-key")

    def test_auto_mode_uses_v7_loader_without_saving_credentials(self):
        with patch.dict(os.environ, {
            "CREATURE_MARKET_SOURCE": "auto", "CREATURE_JQUANTS_API_KEY": ""
        }), patch("game_runtime.market_bridge.load_jquants_key",
                  return_value="test-key-from-v7") as read_key, \
             patch("game_runtime.market_bridge.fetch_jquants") as get_remote:
            get_remote.return_value = {
                "origin": "JQUANTS_API_V2_CACHE", "adjusted": True,
                "source": "J-Quants V2 offline test", "warning": "test",
                "series": {"40050": [
                    ((date(2025, 1, 1) + timedelta(days=offset)).isoformat(),
                     100.0 + index, False)
                    for index, offset in enumerate(
                        [day for day in range(55)
                         if (date(2025, 1, 1) + timedelta(days=day)).weekday() < 5][:36])
                ]}
            }
            from game_runtime.market_bridge import generate
            data = {"base_model": simple_model(),
                    "models": {slot: simple_model()
                               for slot in ("mine", "owl", "turtle")},
                    "selection": {}}
            # The fixture uses consecutive days; avoids relying on V7's real key.
            result = generate(data)
            self.assertEqual(result["source_origin"], "JQUANTS_API_V2_CACHE")
            read_key.assert_called_once_with()
            get_remote.assert_called_once_with("test-key-from-v7")

    def test_read_only_local_source_random_unique_and_replay(self):
        with TemporaryDirectory() as folder:
            path = Path(folder) / "original_source.json"
            start = date(2024, 1, 1)
            days = [start + timedelta(days=i) for i in range(110)
                    if (start + timedelta(days=i)).weekday() < 5]
            rows = [{"Code": "40050", "Date": d.isoformat(),
                     "C": 100 + i * .7, "source_flags": ""}
                    for i, d in enumerate(days)]
            path.write_text(json.dumps({
                "source": "SoftHompo JPX daily reports CSV",
                "series": {"40050": rows}}, ensure_ascii=False), encoding="utf-8")
            before = path.read_bytes()
            with patch.dict(os.environ, {"CREATURE_MARKET_HISTORY_PATH": str(path)}, clear=False):
                source = load_local()
                windows = candidate_windows(source)
                self.assertGreater(len(windows), 2)
                request = {"base_model": simple_model(),
                           "models": {key: simple_model() for key in ("mine", "owl", "turtle")},
                           "selection": {}}
                first = generate(request)
                repeated = generate({**request,
                                     "selection": {"replay_id": first["market_id"]}})
                other = generate({**request,
                                  "selection": {"exclude_id": first["market_id"]}})
                self.assertEqual(first["plan"], repeated["plan"])
                self.assertNotEqual(first["market_id"], other["market_id"])
                self.assertEqual(first["market_id"], repeated["market_id"])
                self.assertEqual(first["brier"]["mine"], first["brier"]["owl"])
                self.assertEqual(len(first["plan"]["signals"]), 12)
                self.assertEqual(first["plan"]["initial_price"], 100)
                self.assertFalse(first["adjusted"])
                self.assertEqual(first["source_origin"], "LOCAL_JPX_REPORT_CACHE_2024")
                self.assertEqual(before, path.read_bytes(), "source must remain unchanged")
                with self.assertRaisesRegex(ValueError, "replay_not_found"):
                    sample_window(windows, {"replay_id": "mkt_" + "f" * 24})

    def test_no_future_data_in_first_forecast(self):
        with TemporaryDirectory() as folder:
            path = Path(folder) / "history.json"
            base = date(2024, 1, 1)
            days = [base + timedelta(days=i) for i in range(90)
                    if (base + timedelta(days=i)).weekday() < 5][:50]
            rows = [{"Code": "40050", "Date": day.isoformat(),
                     "C": round(100 + .9 * i, 2), "source_flags": ""}
                    for i, day in enumerate(days)]
            path.write_text(json.dumps({"source": "SoftHompo JPX daily reports CSV",
                                        "series": {"40050": rows}}), encoding="utf-8")
            with patch.dict(os.environ, {"CREATURE_MARKET_HISTORY_PATH": str(path)}, clear=False):
                source = load_local()
                windows = candidate_windows(source)
                wid, _, sample = windows[0]
                entry = {"base_model": simple_model(),
                         "models": {k: simple_model() for k in ("mine", "owl", "turtle")},
                         "selection": {"replay_id": wid}}
                baseline = generate(entry)
                # Change ONLY the final outcome, never the prior observed history.
                data = json.loads(path.read_text())
                data["series"]["40050"][35]["C"] += .5
                path.write_text(json.dumps(data), encoding="utf-8")
                new_window = candidate_windows(load_local())[0]
                altered = generate({**entry,
                                    "selection": {"replay_id": new_window[0]}})
                self.assertEqual(baseline["plan"]["signals"][0],
                                 altered["plan"]["signals"][0])
                self.assertNotEqual(baseline["market_id"], altered["market_id"])

    def test_unadjusted_corporate_actions_excluded_and_jquants_adj_c(self):
        base = date(2024, 1, 1)
        days = [base + timedelta(days=i) for i in range(110)
                if (base + timedelta(days=i)).weekday() < 5]
        local_rows = [{"Code": "40050", "Date": day.isoformat(),
                       "C": 100 + i, "source_flags": "D" if i == 35 else ""}
                      for i, day in enumerate(days)]
        parsed = checked_rows(local_rows, adjusted=False, expected_code="40050")
        candidates = candidate_windows({
            "series": {"40050": parsed}, "adjusted": False, "origin": "TEST",
        })
        self.assertTrue(candidates)
        self.assertTrue(all(not any(x[2] for x in window)
                            for _, _, window in candidates))
        jquants = [{"Code": "40050", "Date": "2024-01-04",
                    "C": 1000, "AdjC": 500, "AdjFactor": 1}]
        self.assertEqual(checked_rows(jquants, adjusted=True,
                                      expected_code="40050")[0][1], 500)
        with self.assertRaisesRegex(ValueError, "duplicate_market_date"):
            checked_rows(jquants * 2, adjusted=True, expected_code="40050")

    def test_jquants_v2_adjusted_close_uses_one_cached_request(self):
        with TemporaryDirectory() as folder:
            start = date(2025, 1, 1)
            dates = [start + timedelta(days=i) for i in range(130)
                     if (start + timedelta(days=i)).weekday() < 5][:60]
            rows = [{"Code": "40050", "Date": day.isoformat(),
                     "C": 1000 + i * 3, "AdjC": 500 + i * 1.5,
                     "AdjFactor": 1.0} for i, day in enumerate(dates)]
            encoded = json.dumps({"data": rows}).encode("utf-8")

            class Reply:
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def read(self, limit): return encoded

            requests = []
            def request_once(req, timeout):
                self.assertEqual(timeout, 8)
                self.assertIn("https://api.jquants.com/v2/equities/bars/daily?", req.full_url)
                self.assertEqual(req.get_header("X-api-key"), "test-only-key")
                requests.append(req)
                return Reply()

            with patch("game_runtime.market_bridge.ROOT", Path(folder)), \
                 patch("game_runtime.market_bridge.CODES", ("40050",)), \
                 patch.dict(os.environ, {"CREATURE_JQUANTS_API_KEY": "test-only-key"}), \
                 patch("game_runtime.market_bridge.urlopen", side_effect=request_once):
                result = fetch_jquants()
                self.assertTrue(result["adjusted"])
                self.assertEqual(result["series"]["40050"][0][1], 500)
                self.assertEqual(result["origin"], "JQUANTS_API_V2_CACHE")
                self.assertEqual(len(requests), 1)
                cached = fetch_jquants()
                self.assertEqual(cached["series"], result["series"])
                self.assertEqual(len(requests), 1, "second run uses local daily cache")


if __name__ == "__main__":
    unittest.main()

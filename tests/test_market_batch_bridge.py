"""Offline coverage for the deterministic local historical batch runner."""
import io
import json
import os
import unittest
from datetime import date, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from game_runtime import market_batch_bridge as batch
from game_runtime import market_bridge as single


def row_date(index):
    return (date(2024, 1, 1) + timedelta(days=index)).isoformat()


def market_window(code, start, price=100):
    rows = [(row_date(i), price, False) for i in range(start, start + 36)]
    identifier = "mkt_" + f"{int(code) * 1000 + start:024x}"
    return identifier, code, rows


def model():
    return {"fast_window": 4, "slow_window": 10, "risk_fraction": .35,
            "plugin_weights": {"trend": 40, "momentum": 20, "reversion": 25, "volatility": 15},
            "plugin_strengths": dict.fromkeys(("trend", "momentum", "reversion", "volatility"), 100)}


class MarketBatchTests(unittest.TestCase):
    def test_exact_chronological_non_overlap_per_code_ignores_outcomes(self):
        windows = [
            market_window("46890", 15), market_window("40050", 18),
            market_window("40050", 0), market_window("46890", 0),
            market_window("40050", 36), market_window("40050", 35),
            market_window("46890", 37), market_window("40050", 73),
        ]
        expected = [("40050", row_date(n)) for n in (0, 36, 73)] + [
            ("46890", row_date(n)) for n in (0, 37)]
        for order in (windows, windows[::-1],
                      [(ident, code, [(day, price * 2, flag) for day, price, flag in rows])
                       for ident, code, rows in windows]):
            self.assertEqual([(code, rows[0][0]) for _, code, rows in batch.select_windows(order)], expected)

    def test_bad_windows_and_cap_are_fail_closed(self):
        first = market_window("40050", 0)
        for invalid in ([], [first, first], [market_window("90800", 0)],
                        [(first[0], first[1], first[2][1:])],
                        [(first[0], first[1], first[2][::-1])],
                        [(first[0], first[1], [("2025-01-01", 100, False), *first[2][1:]])]):
            with self.assertRaises(ValueError):
                batch.select_windows(invalid)
        many = [market_window(code, 36 * index) for code in single.CODES[:5] for index in range(9)]
        self.assertEqual(len(batch.select_windows(many[:40])), 40)
        with self.assertRaisesRegex(ValueError, "too many disjoint windows"):
            batch.select_windows(many)

    def test_local_runner_loads_once_and_reuses_identical_single_window_math(self):
        with TemporaryDirectory() as root:
            path = Path(root) / "prehistory.json"
            rows = [{"Code": "40050", "Date": row_date(index), "C": 100 + index * .3} for index in range(80)]
            path.write_text(json.dumps({"source": "SoftHompo JPX daily reports CSV", "series": {"40050": rows}}))
            before = path.read_bytes()
            data = {"base_model": model(), "models": dict.fromkeys(single.SLOTS, model())}
            with patch.dict(os.environ, {"CREATURE_MARKET_HISTORY_PATH": str(path), "CREATURE_MARKET_SOURCE": "jquants",
                                         "CREATURE_JQUANTS_API_KEY": "fake-key"}), \
                 patch.object(single, "load_jquants_key", side_effect=AssertionError("credential access")), \
                 patch.object(single, "fetch_jquants", side_effect=AssertionError("network")), \
                 patch.object(single, "load_local", wraps=single.load_local) as read_local:
                result = batch.evaluate(data)
                read_local.assert_called_once_with()
                self.assertEqual((result["eligible_windows"], result["selected_windows"]), (45, 2))
                self.assertEqual([row["start_date"] for row in result["windows"]], [row_date(0), row_date(36)])
                with patch.dict(os.environ, {"CREATURE_MARKET_SOURCE": "local"}):
                    for row in result["windows"]:
                        self.assertEqual(row, single.generate({**data, "selection": {"replay_id": row["market_id"]}}))
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(list(Path(root).iterdir()), [path])

    def test_input_and_utf8_output_limits_reject_without_partial_stdout(self):
        output = io.BytesIO()
        with patch.object(batch, "evaluate", side_effect=AssertionError("oversized request evaluated")):
            with self.assertRaisesRegex(ValueError, "batch input too large"):
                batch.main(io.BytesIO(b"x" * (batch.MAX_INPUT + 1)), output)
        with patch.object(batch, "evaluate", return_value={"large": "あ" * 90000}):
            with self.assertRaisesRegex(ValueError, "batch output too large"):
                batch.main(io.BytesIO(b"{}"), output)
        self.assertEqual(output.getvalue(), b"")

    def test_request_rejects_user_selection_before_reading_source(self):
        with patch.object(single, "load_local", side_effect=AssertionError("malformed request accessed source")):
            for bad in ({}, {"base_model": model(), "models": {}, "selection": {}},
                        {"base_model": model(), "models": {}, "code": "40050"}):
                with self.assertRaises(ValueError):
                    batch.evaluate(bad)


if __name__ == "__main__":
    unittest.main()

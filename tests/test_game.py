"""Practice simulation and version-store regression tests."""
import json
import math
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import game
from engine import Model, SYNTHETIC_PRICES


class GameTests(unittest.TestCase):
    def test_only_synthetic_paper_coins(self):
        result = game.run_practice(Model(), {"mine": 40, "owl": 30, "turtle": 20})
        self.assertEqual(result["initial_coins"], 10000)
        self.assertEqual(result["steps"], len(game.PRACTICE_PATH))
        self.assertEqual(result["mode"], "PRACTICE_SYNTHETIC_ONLY")
        self.assertEqual(result["cash_unallocated"], 1000)
        self.assertEqual(result["equity_path"][0], 10000)
        self.assertEqual(len(result["equity_path"]), 13)
        self.assertEqual(len(result["benchmark_path"]), 13)
        self.assertAlmostEqual(sum(
            character["final"] for character in result["characters"].values()
        ) + 1000, result["final_coins"], delta=.03)
        self.assertTrue(math.isfinite(result["max_drawdown_pct"]))
        self.assertLessEqual(result["max_drawdown_pct"], 100)
        self.assertGreaterEqual(result["max_drawdown_pct"], 0)
        self.assertTrue(all(x["fees"] >= 0 for x in result["characters"].values()))

    def test_zero_allocation_does_not_invent_money(self):
        result = game.run_practice(Model(), {"mine":0,"owl":0,"turtle":0})
        self.assertEqual(result["final_coins"],10000)
        self.assertEqual(result["profit_coins"],0)
        self.assertEqual(result["max_drawdown_pct"],0)
        self.assertEqual(result["cash_unallocated"],10000)
        self.assertTrue(all(x==10000 for x in result["equity_path"]))

    def test_fee_totals_nonnegative(self):
        result = game.run_practice(Model(), {"mine":0,"owl":100,"turtle":0})
        self.assertGreaterEqual(result["characters"]["owl"]["fees"], 0)

    def test_first_decision_does_not_see_future(self):
        original = game.run_practice(Model(), {"mine":50,"owl":50,"turtle":0})
        with patch.object(game,"PRACTICE_PATH",(99,94,92,84,88,91,92,90,82,83,81,70)):
            changed = game.run_practice(Model(), {"mine":50,"owl":50,"turtle":0})
        self.assertEqual(
            original["decisions"][0]["signals"],changed["decisions"][0]["signals"]
        )
        self.assertEqual(original["equity_path"][0],changed["equity_path"][0])
        self.assertNotEqual(original["equity_path"][-1],changed["equity_path"][-1])

    def test_reject_bad_allocations(self):
        for bad in [
            {}, {"mine":101,"owl":0,"turtle":0},
            {"mine":60,"owl":60,"turtle":0},
            {"mine":True,"owl":0,"turtle":0},
            {"mine":50.5,"owl":0,"turtle":0},
            {"mine":-1,"owl":0,"turtle":0},
            {"mine":50,"owl":50,"turtle":0,"unknown":0},
        ]:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    game.run_practice(Model(),bad)

    def test_snapshot_save_reopen_integrity(self):
        with TemporaryDirectory() as temp:
            file=Path(temp)/"versions.json"
            with patch.object(game,"SAVE_FILE",file):
                model=Model(4,13,.65)
                self.assertEqual(game.read_versions(),[])
                entry=game.save_version("My safe version",model)
                self.assertTrue(file.is_file())
                self.assertEqual(entry["model"]["fast_window"],4)
                self.assertEqual(game.load_version(entry["id"]),model)
                self.assertEqual(len(game.read_versions()),1)
                second=game.save_version("Second",Model(5,12,.5))
                self.assertEqual(len(game.read_versions()),2)
                self.assertNotEqual(entry["id"],second["id"])
                corrupted=json.loads(file.read_text())
                corrupted["versions"][0]["model"]["fast_window"]=8
                file.write_text(json.dumps(corrupted))
                with self.assertRaises(ValueError):
                    game.load_version(entry["id"])

    def test_snapshot_reject_path_and_long_name(self):
        with TemporaryDirectory() as temp:
            with patch.object(game,"SAVE_FILE",Path(temp)/"versions.json"):
                for bad in ["", " " * 3, "../bad", "A" * 41, "\\bad", "\x00abc", 123]:
                    with self.subTest(bad=bad):
                        with self.assertRaises(ValueError):
                            game.save_version(bad, Model())
                with self.assertRaises(ValueError):
                    game.load_version("../../hack")


if __name__=="__main__":
    unittest.main()

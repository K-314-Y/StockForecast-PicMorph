"""P9ag offline regression checks. Run with python3 -B scripts/test_accessory_regimes.py."""
import hashlib
import unittest

import accessory_regime_plans as study


class RegimeChecks(unittest.TestCase):
    def test_replay_and_disjoint_paths(self):
        fingerprints = {
            "development": "4d0c263e31dc3fdd26924f1afc49a0f09df03ae6e3f2487b2ce532ae1e96b61c",
            "validation": "2663993acb3adaa8233a747e2aa056e700d46b33858469ce61a9d6c3f7f91e1e",
        }
        seen = set()
        for split in study.SETS:
            digest = hashlib.sha256()
            for regime in study.TYPES:
                for i in range(study.COUNT):
                    path = study.prices(split, regime, i)
                    self.assertEqual(path, study.prices(split, regime, i))
                    self.assertEqual(len(path), 12)
                    self.assertGreater(min(path), 0)
                    self.assertNotIn(path, seen)
                    seen.add(path)
                    for price in path:
                        digest.update(round(price * 100).to_bytes(4, "big"))
            self.assertEqual(digest.hexdigest(), fingerprints[split])

    def test_every_decision_precedes_its_close(self):
        for regime in study.TYPES:
            path = study.prices("validation", regime, 0)
            original = dict(study.plans(path))
            for day in range(12):
                # Replace today's close as well as the entire unseen suffix.
                altered = path[:day] + tuple(75 + 50 * (j % 2) for j in range(12-day))
                for name, plan in study.plans(altered):
                    self.assertEqual(plan["signals"][:day+1], original[name]["signals"][:day+1])

    def test_matches_legacy_benchmark_plans(self):
        token = "v1_0123456789abcdef"
        path = study.bridge.scenario_prices(token)
        options = {
            "standard": {},
            **{key: {"accessory_strategy": key} for key in ("star", "glasses", "ribbon", "none")},
            "triple": {"accessory_methods": ["bollinger_breakout", "rsi_oversold", "macd_momentum"]},
        }
        model = {"fast_window": 3, "slow_window": 9, "risk_fraction": .35,
                 "plugin_weights": {"trend": 100, "momentum": 0, "reversion": 0, "volatility": 0},
                 "plugin_strengths": dict.fromkeys(("trend", "momentum", "reversion", "volatility"), 100)}
        plans = dict(study.plans(path))
        self.assertEqual(plans.keys(), options.keys())
        for name, plan in plans.items():
            legacy = study.bridge.create_prediction_plan({
                "base_model": model, "models": dict.fromkeys(("mine", "owl", "turtle"), model),
                "scenario_token": token, **options[name],
            })
            legacy.update(initial_coins=1000, allocations={"mine": 100, "owl": 0, "turtle": 0})
            self.assertEqual(plan, legacy)


if __name__ == "__main__":
    unittest.main()

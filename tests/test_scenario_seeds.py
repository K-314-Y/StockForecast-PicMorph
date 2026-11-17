"""Versioned fictional scenarios: determinism, isolation, and no future leakage."""
import copy
import hashlib
import json
import unittest
from unittest.mock import patch
from engine import SYNTHETIC_PRICES, prediction
from game_runtime.predict_bridge import (FUTURE, SLOTS, create_prediction_plan,
                                        model_from_record, scenario_prices)
MODEL = dict(fast_window=3, slow_window=9, risk_fraction=.35,
             plugin_weights=dict(trend=100, momentum=0, volatility=0, reversion=0),
             plugin_strengths=dict(trend=100, momentum=100, volatility=100, reversion=100))
TOKEN = "v1_0123456789abcdef"


def request(token=TOKEN):
    return dict(base_model=copy.deepcopy(MODEL),
                models={key: copy.deepcopy(MODEL) for key in SLOTS},
                scenario_token=token)


class ScenarioTests(unittest.TestCase):
    def test_deterministic_model_independent_and_bounded(self):
        a = create_prediction_plan(request())
        other = request()
        other["models"]["mine"]["plugin_weights"] = dict(trend=0, momentum=0, volatility=0, reversion=100)
        b = create_prediction_plan(other)
        self.assertEqual(json.dumps(a["future_prices"]), json.dumps(b["future_prices"]))
        self.assertNotEqual(a["signals"], b["signals"])
        self.assertEqual(a, create_prediction_plan(request()))
        self.assertEqual(a["future_prices"], [
            109.95, 108.32, 109.59, 107.78, 105.96, 105.44,
            107.07, 110.27, 111.15, 113.34, 116.06, 113.43])
        self.assertEqual(SYNTHETIC_PRICES[-1], 109)
        self.assertEqual(len(a["future_prices"]), 12)
        previous = 109
        for price in a["future_prices"]:
            self.assertTrue(0 < price <= 1e12)
            self.assertLessEqual(abs(price / previous - 1), .0351)
            previous = price
        self.assertGreater(sum(x != y for x, y in zip(
            a["future_prices"], scenario_prices("v1_fedcba9876543210"))), 10)

    def test_legacy_and_prior_history_only(self):
        for token in (None, TOKEN, "v1_fedcba9876543210"):
            data = request(token)
            if token is None:
                del data["scenario_token"]
            plan = create_prediction_plan(data)
            if token is None:
                self.assertEqual(plan["future_prices"], list(FUTURE))
                # Complete token-free plan captured from main 1612ca9.
                self.assertEqual(hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest(),
                                 "73ff766fdfc5e090eed52ba9883b962043524eaffdf084b1cb67c5cf4106528b")
            history = list(SYNTHETIC_PRICES)
            for price, signals in zip(plan["future_prices"], plan["signals"]):
                for slot in SLOTS:
                    probs = prediction(model_from_record(data["models"][slot]), tuple(history))
                    expected = "LONG" if probs["UP"] > .52 and probs["UP"] > probs["DOWN"] + .05 else "CASH"
                    self.assertEqual(signals[slot], expected)
                history.append(price)
        original = create_prediction_plan(request())
        # Alter day N and all subsequent prices: predictions through N stay identical.
        for day in range(12):
            altered = original["future_prices"][:day] + [900] * (12-day)
            with patch("game_runtime.predict_bridge.scenario_prices", return_value=altered):
                result = create_prediction_plan(request())
            self.assertEqual(result["signals"][:day+1], original["signals"][:day+1])

    def test_reject_malformed_and_extra(self):
        for token in (None, 1, [], {}, "", TOKEN+"\n", TOKEN+"0", TOKEN.upper(), "v2_"+TOKEN[3:]):
            with self.assertRaises(ValueError):
                create_prediction_plan(request(token))
        data = request()
        data["seed"] = TOKEN
        with self.assertRaises(ValueError):
            create_prediction_plan(data)

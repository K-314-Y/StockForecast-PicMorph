"""Offline tests. No credentials, broker accounts, downloads or external data."""
import math
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import (
    EYES, Model, SYNTHETIC_PRICES, model_from_python, multiclass_brier,
    prediction, python_source, view, with_visual_change,
)


class RoundTripTests(unittest.TestCase):
    def test_round_trip_every_preset(self):
        for name in EYES:
            with self.subTest(name=name):
                changed = with_visual_change(Model(), eye=name)
                source = python_source(changed)
                self.assertEqual(changed, model_from_python(source))
                self.assertEqual(name, view(changed)["visual"]["eye"])

    def test_source_can_drive_custom_visual(self):
        source = python_source(Model()).replace("FAST_WINDOW = 3", "FAST_WINDOW = 4")
        custom = model_from_python(source)
        self.assertEqual(custom.fast_window, 4)
        self.assertEqual(view(custom)["visual"]["eye"], "custom")
        self.assertEqual(custom, model_from_python(python_source(custom)))

    def test_equipment_changes_prediction(self):
        values = [
            prediction(with_visual_change(Model(), eye=name))["UP"]
            for name in EYES
        ]
        self.assertEqual(len(set(round(x, 6) for x in values)), len(EYES))

    def test_shield_changes_coin_limit_not_prices(self):
        a = with_visual_change(Model(), risk=0.1)
        b = with_visual_change(Model(), risk=0.85)
        self.assertEqual(prediction(a), prediction(b))
        self.assertEqual(view(a)["sample_coins_exposed"], 1000)
        self.assertEqual(view(b)["sample_coins_exposed"], 8500)
        self.assertNotEqual(view(a)["visual"]["shield_intensity"],
                            view(b)["visual"]["shield_intensity"])

    def test_probs_sum_to_one(self):
        for eye in EYES:
            model = with_visual_change(Model(), eye=eye)
            result = prediction(model)
            self.assertAlmostEqual(sum(result.values()), 1.0)
            self.assertTrue(all(0 <= v <= 1 for v in result.values()))

    def test_source_function_matches_engine(self):
        # Only trusted, generated, unmodified template is executed in this test.
        for eye in EYES:
            model = with_visual_change(Model(), eye=eye)
            local_scope = {"__builtins__": {"sum": sum, "max": max, "min": min, "abs": abs}}
            exec(compile(python_source(model), "<trusted-generated-test>", "exec"),
                 local_scope)
            sample = local_scope["forecast"](SYNTHETIC_PRICES)
            for k, v in prediction(model).items():
                self.assertAlmostEqual(sample[k], v)

    def test_code_injection_denied(self):
        src = python_source(Model())
        malicious = [
            src + "\nimport os\nos.system('id')",
            src.replace("FAST_WINDOW = 3", "FAST_WINDOW = __import__('os')"),
            src.replace("return {{", "return {{"),  # harmless duplicate is removed below
            src.replace("momentum / 0.06", "momentum / 99"),
            src.replace("FAST_WINDOW = 3", "FAST_WINDOW = True"),
            src.replace("FAST_WINDOW = 3", "FAST_WINDOW = -1"),
        ]
        del malicious[2]
        for value in malicious:
            with self.subTest(value=value[:50]):
                with self.assertRaises(ValueError):
                    model_from_python(value)

    def test_invalid_settings_denied(self):
        for spec in [(3, 3, .35), (0, 8, .35), (3, 21, .35),
                     (3, 8, float("nan")), (3, 8, True), (3, 8, 0),
                     (3.0, 8, .35)]:
            with self.subTest(spec=spec):
                with self.assertRaises(ValueError):
                    Model(*spec)

    def test_bad_synthetic_input_denied(self):
        with self.assertRaises(ValueError):
            prediction(Model(), (100, 101))
        with self.assertRaises(ValueError):
            prediction(Model(), SYNTHETIC_PRICES[:-1] + (float("nan"),))

    def test_brier_v6_formula(self):
        p = {"UP": .5, "FLAT": .2, "DOWN": .3}
        self.assertAlmostEqual(multiclass_brier("UP", p), .38)
        with self.assertRaises(ValueError):
            multiclass_brier("UP", {"UP": 1.2, "FLAT": -.1, "DOWN": -.1})

    def test_model_has_no_external_dependency(self):
        source = python_source(Model())
        self.assertNotIn("import requests", source)
        self.assertNotIn("JQUANTS", source)
        self.assertTrue(all(type(x) is int for x in SYNTHETIC_PRICES))


if __name__ == "__main__":
    unittest.main()

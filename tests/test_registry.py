"""Sprint 5: dynamic registered indicators and historical version safety."""
import hashlib
import json
import math
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import game
from engine import (
    Model, PLUGIN_IDS, PLUGIN_INFO, SYNTHETIC_PRICES,
    python_source, sprint4_python_source, model_from_python,
    prediction, prediction_components, view, with_plugin_change
)
from indicators import REGISTRY, reversion_indicator


class RegistryTests(unittest.TestCase):
    def test_catalog_single_source_of_truth(self):
        self.assertEqual(len(REGISTRY), 4)
        self.assertEqual(PLUGIN_IDS, tuple(spec.id for spec in REGISTRY))
        self.assertEqual(PLUGIN_INFO, tuple(spec.public_info() for spec in REGISTRY))
        self.assertEqual(len(view(Model())["plugins"]), len(REGISTRY))
        self.assertEqual(tuple(view(Model())["model"]["plugin_weights"]), PLUGIN_IDS)

    def test_reversion_actually_changes_probability(self):
        prices_high = (100,) * 30 + (110,)
        prices_low = (100,) * 30 + (90,)
        high = reversion_indicator(prices_high, 3, 12)
        low = reversion_indicator(prices_low, 3, 12)
        self.assertGreater(high["DOWN"], high["UP"])
        self.assertGreater(low["UP"], low["DOWN"])

    def test_each_registered_builtin_matches_exposed_code(self):
        model = Model(4, 13, .5, (20, 20, 15, 45))
        source = python_source(model)
        safe_globals = {
            "__builtins__": {
                "sum":sum,"max":max,"min":min,"range":range,
                "len":len,"abs":abs,
            }
        }
        # Only audited, locally generated code runs here. Never user input.
        exec(compile(source,"<built-in-registry-test>","exec"),safe_globals)
        pairs = [
            SYNTHETIC_PRICES,
            tuple(100+i for i in range(40)),
            tuple(150-i for i in range(40)),
        ]
        for prices in pairs:
            direct = prediction(model,prices)
            generated = safe_globals["forecast"](prices)
            for key in ("UP","FLAT","DOWN"):
                self.assertAlmostEqual(direct[key],generated[key],places=11)
            self.assertAlmostEqual(sum(direct.values()),1.0,places=11)
        self.assertEqual(model,model_from_python(source))

    def test_four_plugin_mixture_and_old_source(self):
        older = Model(5,12,.35)
        old_source = sprint4_python_source(older)
        self.assertEqual(model_from_python(old_source),older)
        model = Model(5,12,.35,(20,20,10,50))
        values = prediction(model)
        parts = prediction_components(model)
        for key in ("UP","FLAT","DOWN"):
            estimate = sum(parts[k][key]*w/100 for k,w in zip(PLUGIN_IDS, model.plugin_weights))
            self.assertAlmostEqual(values[key],estimate)
        with self.assertRaises(ValueError):
            with_plugin_change(model,{"trend":100,"momentum":0,"volatility":0})
        tampered = python_source(model).replace("return {\"UP\": up", "return {\"UP\": 999")
        with self.assertRaises(ValueError):
            model_from_python(tampered)

    def test_sprint4_saved_model_hash_migrates_without_unsafe_rewrite(self):
        old_model = Model(4,13,.65,(50,30,20,0))
        legacy_sha = hashlib.sha256(sprint4_python_source(old_model).encode()).hexdigest()
        old_entry = {
            "id":"c"*32,
            "name":"sprint4 archived",
            "saved_at":"2026-10-27T20:00:00+00:00",
            "model":{
                "fast_window":4,"slow_window":13,"risk_fraction":.65,
                "plugin_weights":{"trend":50,"momentum":30,"volatility":20}
            },
            "sha256":legacy_sha,
        }
        with TemporaryDirectory() as temp:
            file = Path(temp)/"versions.json"
            file.write_text(json.dumps({"schema":1,"versions":[old_entry]}),encoding="utf-8")
            with patch.object(game,"SAVE_FILE",file):
                loaded=game.load_version(old_entry["id"])
                self.assertEqual(loaded,old_model)
                self.assertEqual(file.read_text(encoding="utf-8"),json.dumps({"schema":1,"versions":[old_entry]}))
                new=game.save_version("Sprint 5",Model(4,13,.4,(10,20,20,50)))
                self.assertIn("reversion",new["model"]["plugin_weights"])
                self.assertEqual(game.load_version(new["id"]).plugin_weights,(10,20,20,50))
                contents=json.loads(file.read_text())
                contents["versions"][-1]["model"]["plugin_weights"]["reversion"]=49
                file.write_text(json.dumps(contents))
                with self.assertRaises(ValueError):
                    game.load_version(new["id"])

    def test_no_future_peeking_or_arbitrary_plugin_registration(self):
        model = Model(5,12,.35,(0,0,0,100))
        prices = tuple(SYNTHETIC_PRICES)
        assert prediction(model,prices)==prediction(model,(prices+(1000,))[:-1])
        for bad in [
            {"trend":10,"momentum":10,"volatility":10,"reversion":70,"shell":0},
            {"trend":10,"momentum":10,"volatility":10,"reversion":True},
        ]:
            with self.assertRaises(ValueError):
                with_plugin_change(model,bad)


if __name__ == "__main__":
    unittest.main()

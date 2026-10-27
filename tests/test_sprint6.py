"""Sprint 6: independently tuned built-in indicators and per-character roster."""
import hashlib
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import game
import lineup
from engine import (
    Model, PLUGIN_IDS, prediction, prediction_components, python_source,
    sprint5_python_source, model_from_python, with_plugin_strength_change,
    with_plugin_change, with_visual_change, view,
)


class SprintSix(unittest.TestCase):
    def test_default_sensitivity_retains_previous_math(self):
        m=Model(4,13,.5,(20,20,10,50))
        expected = prediction(m)
        actual = prediction(Model(4,13,.5,(20,20,10,50),(100,100,100,100)))
        self.assertEqual(expected,actual)
        self.assertEqual(m,model_from_python(sprint5_python_source(m)))
        self.assertEqual(m,model_from_python(python_source(m)))
        self.assertEqual(m.plugin_strengths,(100,100,100,100))

    def test_strengths_change_results_and_generated_preview(self):
        m=Model(4,13,.45,(20,20,10,50),(140,60,100,120))
        self.assertNotEqual(prediction(m),prediction(Model(4,13,.45,(20,20,10,50))))
        self.assertEqual(m,model_from_python(python_source(m)))
        raw=python_source(m)
        self.assertIn("STRENGTH_REVERSION = 120",raw)
        trusted_globals={"__builtins__":{"sum":sum,"max":max,"min":min,"range":range,"len":len,"abs":abs,"enumerate":enumerate}}
        exec(compile(raw,"<project-generated-only>","exec"),trusted_globals)
        samples=[
            tuple(100+i for i in range(40)),
            tuple(150-i for i in range(40)),
            tuple([100]*39+[150]),
        ]
        for prices in samples:
            direct=prediction(m,prices)
            generated=trusted_globals["forecast"](prices)
            for k in ("UP","FLAT","DOWN"):
                self.assertAlmostEqual(direct[k],generated[k],places=11)
            self.assertAlmostEqual(sum(direct.values()),1,places=12)
        self.assertEqual(view(m)["model"]["plugin_strengths"]["trend"],140)
        self.assertEqual(view(m)["plugins"][3]["strength_pct"],120)

    def test_reject_bad_strengths_and_code_edits(self):
        m=Model()
        valid=dict.fromkeys(PLUGIN_IDS,100)
        for bad in (
            {**valid,"trend":49},
            {**valid,"momentum":151},
            {**valid,"volatility":True},
            {**valid,"reversion":100.0},
            {k:v for k,v in valid.items() if k!="reversion"},
            {**valid,"shell":100},
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    with_plugin_strength_change(m,bad)
        source=python_source(m)
        for evil in (
            source.replace("STRENGTH_TREND = 100","STRENGTH_TREND = __import__('os')"),
            source.replace("STRENGTH_TREND = 100","STRENGTH_TREND = 500"),
            source.replace("STRENGTH_TREND = 100","STRENGTH_TREND = 100\nimport os"),
            source.replace("return probs\n","return {'UP':1.0,'FLAT':0.0,'DOWN':0.0}\n",1),
        ):
            with self.subTest(src=evil[:80]):
                with self.assertRaises(ValueError):
                    model_from_python(evil)

    def test_visual_and_weight_change_keep_plugin_strengths(self):
        m=Model(4,13,.7,(20,30,10,40),(85,130,110,150))
        self.assertEqual(with_visual_change(m,eye="owl").plugin_strengths,m.plugin_strengths)
        self.assertEqual(with_visual_change(m,risk=.55).plugin_strengths,m.plugin_strengths)
        weights=dict(zip(PLUGIN_IDS,(50,20,10,20)))
        self.assertEqual(with_plugin_change(m,weights).plugin_strengths,m.plugin_strengths)

    def test_old_sprint5_snapshot_read_only_upgrade(self):
        with TemporaryDirectory() as tmp:
            file=Path(tmp)/"versions.json"
            model=Model(4,13,.4,(25,25,20,30))
            old_entry={
                "id":"a"*32,"name":"old sprint5","saved_at":"2026-10-27T10:00:00+00:00",
                "model":{
                    "fast_window":4,"slow_window":13,"risk_fraction":.4,
                    "plugin_weights":dict(zip(PLUGIN_IDS,model.plugin_weights))
                },
                "sha256":hashlib.sha256(sprint5_python_source(model).encode()).hexdigest(),
            }
            data=json.dumps({"schema":1,"versions":[old_entry]})
            file.write_text(data)
            with patch.object(game,"SAVE_FILE",file):
                self.assertEqual(game.load_version(old_entry["id"]),model)
                self.assertEqual(file.read_text(),data)
                new=game.save_version("new sensitivity",Model(4,13,.4,(25,25,20,30),(140,80,100,120)))
                self.assertEqual(game.load_version(new["id"]).plugin_strengths,(140,80,100,120))
                broken=json.loads(file.read_text())
                broken["versions"][1]["model"]["plugin_strengths"]["trend"]=120
                file.write_text(json.dumps(broken))
                with self.assertRaises(ValueError):
                    game.load_version(new["id"])

    def test_character_lineup_independent_and_persistent(self):
        with TemporaryDirectory() as tmp:
            saved=Path(tmp)/"versions.json"
            selected=Path(tmp)/"lineup.json"
            with patch.object(game,"SAVE_FILE",saved),patch.object(lineup,"LINEUP_FILE",selected):
                self.assertEqual(lineup.read_lineup()["revision"],0)
                self.assertEqual(lineup.effective_models(),{})
                owl=Model(3,9,.75,(0,10,0,90),(100,100,100,150))
                turtle=Model(8,20,.25,(50,0,50,0),(100,100,150,100))
                a=game.save_version("owl-custom",owl)
                b=game.save_version("turtle-custom",turtle)
                one=lineup.assign_model("owl",a["id"],0)
                self.assertEqual(one["revision"],1)
                self.assertEqual(one["assignments"]["owl"],a["id"])
                self.assertEqual(one["slots"][0]["model"]["plugin_strengths"]["reversion"],150)
                two=lineup.assign_model("turtle",b["id"],1)
                self.assertEqual(two["revision"],2)
                self.assertEqual(lineup.effective_models(),{"owl":owl,"turtle":turtle})
                self.assertEqual(lineup.read_lineup()["revision"],2)
                default=game.run_practice(Model(),{"mine":0,"owl":50,"turtle":50})
                assigned=game.run_practice(Model(),{"mine":0,"owl":50,"turtle":50},
                                           assigned=lineup.effective_models())
                self.assertNotEqual(default["characters"]["owl"]["plugin_weights"],
                                    assigned["characters"]["owl"]["plugin_weights"])
                self.assertNotEqual(default["characters"]["owl"]["plugin_strengths"],
                                    assigned["characters"]["owl"]["plugin_strengths"])
                self.assertEqual(assigned["characters"]["turtle"]["plugin_strengths"]["volatility"],150)
                with self.assertRaises(LookupError):
                    lineup.assign_model("owl",b["id"],0)
                self.assertEqual(lineup.read_lineup()["revision"],2)
                with self.assertRaises(ValueError):
                    lineup.assign_model("mine",a["id"],2)
                with self.assertRaises(ValueError):
                    lineup.assign_model("owl","b"*32,2)
                self.assertEqual(lineup.read_lineup()["revision"],2)
                cleared=lineup.assign_model("owl",None,2)
                self.assertIsNone(cleared["assignments"]["owl"])
                self.assertEqual(cleared["assignments"]["turtle"],b["id"])
                self.assertEqual(lineup.effective_models(),{"turtle":turtle})

    def test_corrupt_lineup_does_not_overwrite(self):
        with TemporaryDirectory() as tmp:
            file=Path(tmp)/"lineup.json"
            with patch.object(lineup,"LINEUP_FILE",file):
                file.write_text('{"schema":2,"revision":0,"assignments":{}}')
                with self.assertRaises(ValueError):
                    lineup.read_lineup()
                before=file.read_text()
                with self.assertRaises(ValueError):
                    lineup.assign_model("owl",None,0)
                self.assertEqual(file.read_text(),before)


if __name__=="__main__":
    unittest.main()

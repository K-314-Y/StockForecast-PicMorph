"""Sprint 7 progression tests: bounded XP, equipment, safety and migration."""
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))

import growth
from engine import Model, prediction, PLUGIN_IDS
from game import run_practice


class GrowthTests(unittest.TestCase):
    def setUp(self):
        self.tmp=TemporaryDirectory()
        self.file=Path(self.tmp.name)/"growth.json"
        self.scope=patch.object(growth,"FILE",self.file)
        self.scope.start()

    def tearDown(self):
        self.scope.stop()
        self.tmp.cleanup()

    def _models(self):
        return {"mine":Model(),"owl":Model(5,12,.5),"turtle":Model(8,20,.25)}

    def test_xp_once_even_after_repeated_practice(self):
        first=growth.complete_training({"mine":40,"owl":30,"turtle":20},0)
        self.assertEqual(first["earned_xp"],{"mine":30,"owl":30,"turtle":30})
        self.assertEqual(first["growth"]["revision"],1)
        second=growth.complete_training({"mine":40,"owl":30,"turtle":30},1)
        self.assertEqual(second["earned_xp"],{"mine":10,"owl":10,"turtle":10})
        self.assertEqual(second["growth"]["revision"],2)
        self.assertTrue(all(c["xp"]==40 for c in second["growth"]["slots"]))
        self.assertTrue(all(c["level"]==3 for c in second["growth"]["slots"]))
        before=self.file.read_bytes()
        third=growth.complete_training({"mine":40,"owl":30,"turtle":30},2)
        self.assertEqual(third["earned_xp"],{"mine":0,"owl":0,"turtle":0})
        self.assertEqual(third["growth"]["revision"],2)
        self.assertEqual(self.file.read_bytes(),before)
        self.assertEqual(sum(growth.CHALLENGES[x]["xp"] for x in growth.CHALLENGES),40)

    def test_gear_locked_and_invalid_inputs_do_not_modify(self):
        self.assertEqual(growth.public_growth()["slots"][0]["level"],1)
        with self.assertRaises(ValueError):
            growth.equip("mine","focus_lens",0)
        with self.assertRaises(ValueError):
            growth.equip("bad","none",0)
        with self.assertRaises(ValueError):
            growth.equip("mine","unknown",0)
        with self.assertRaises(ValueError):
            growth.complete_training({"mine":0,"owl":0,"turtle":0},0)
        with self.assertRaises(ValueError):
            growth.complete_training({"mine":60,"owl":60,"turtle":0},0)
        with self.assertRaises(LookupError):
            growth.complete_training({"mine":100,"owl":0,"turtle":0},1)
        self.assertFalse(self.file.exists())
        single=growth.complete_training({"mine":100,"owl":0,"turtle":0},0)
        self.assertEqual(single["earned_xp"],{"mine":30})
        self.assertEqual(single["growth"]["slots"][0]["xp"],30)
        self.assertEqual(single["growth"]["slots"][1]["xp"],0)
        with self.assertRaises(ValueError):
            growth.equip("owl","focus_lens",1)
        with self.assertRaises(ValueError):
            growth.equip("mine","calm_halo",1)
        with self.assertRaises(LookupError):
            growth.equip("mine","focus_lens",0)
        self.assertEqual(growth.read_growth()["revision"],1)
        ok=growth.equip("mine","focus_lens",1)
        self.assertEqual(ok["revision"],2)
        self.assertEqual(ok["slots"][0]["gear"],"focus_lens")
        same=growth.equip("mine","focus_lens",2)
        self.assertEqual(same["revision"],2)

    def test_gear_affects_prediction_not_saved_source(self):
        baseline=self._models()
        untouched=growth.equipped_models(baseline)
        self.assertEqual(untouched,baseline)
        growth.complete_training({"mine":100,"owl":0,"turtle":0},0)
        growth.equip("mine","focus_lens",1)
        applied=growth.equipped_models(baseline)
        self.assertEqual(applied["mine"].plugin_strengths,(110,100,100,100))
        self.assertEqual(baseline["mine"].plugin_strengths,(100,100,100,100))
        self.assertEqual(applied["owl"],baseline["owl"])
        self.assertNotEqual(prediction(applied["mine"]),prediction(baseline["mine"]))
        result=run_practice(baseline["mine"],{"mine":100,"owl":0,"turtle":0},assigned=applied)
        self.assertEqual(result["characters"]["mine"]["plugin_strengths"]["trend"],110)
        self.assertEqual(result["characters"]["mine"]["plugin_weights"]["trend"],100)
        self.assertEqual(result["characters"]["owl"]["plugin_strengths"]["trend"],100)
        self.assertNotEqual(result["characters"]["mine"]["effective_sha256"],
                            result["model_sha256"])
        self.assertEqual(result["initial_coins"],10000)

    def test_three_characters_independent(self):
        growth.complete_training({"mine":50,"owl":50,"turtle":0},0)
        growth.equip("mine","focus_lens",1)
        growth.equip("owl","spark_charm",2)
        result=growth.equipped_models(self._models())
        self.assertEqual(result["mine"].plugin_strengths,(110,100,100,100))
        self.assertEqual(result["owl"].plugin_strengths,(100,115,100,100))
        self.assertEqual(result["turtle"].plugin_strengths,(100,100,100,100))
        self.assertEqual(growth.public_growth()["slots"][2]["xp"],0)
        self.assertEqual(growth.read_growth()["revision"],3)

    def test_file_corruption_unknown_xp_and_illegal_gear_rejected(self):
        record=growth._empty()
        cases=[
            {**record,"schema":2},
            {**record,"revision":-1},
            {**record,"slots":{**record["slots"],"mine":{"achievements":["first_practice","first_practice"],"gear":"none"}}},
            {**record,"slots":{**record["slots"],"mine":{"achievements":["admin"],"gear":"none"}}},
            {**record,"slots":{**record["slots"],"mine":{"achievements":[],"gear":"calm_halo"}}},
        ]
        for malformed in cases:
            with self.subTest(malformed=malformed):
                self.file.write_text(json.dumps(malformed))
                original=self.file.read_bytes()
                with self.assertRaises(ValueError):
                    growth.read_growth()
                with self.assertRaises(ValueError):
                    growth.complete_training({"mine":100,"owl":0,"turtle":0},0)
                self.assertEqual(self.file.read_bytes(),original)


if __name__=="__main__":
    unittest.main()

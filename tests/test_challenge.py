"""Sprint 8 offline challenge tests, no network or saved-state writes."""
import unittest
from unittest.mock import patch

from challenge import (
    SCENARIOS, KEYS, SLOTS, _rank, _simulate, actual_direction,
    public_scenarios, run_challenge,
)
from engine import Model, SYNTHETIC_PRICES, multiclass_brier, prediction
from game import PRESETS

MODELS={"mine":Model(), **PRESETS}


class ChallengeTests(unittest.TestCase):
    def test_validated_uniform_scenarios_and_repeatability(self):
        self.assertEqual(len(public_scenarios()),3)
        for ident, item in SCENARIOS.items():
            with self.subTest(scenario=ident):
                self.assertEqual(len(item["prices"]),12)
                initial = run_challenge(ident,MODELS)
                second = run_challenge(ident,MODELS)
                self.assertEqual(initial,second)
                self.assertEqual(initial["steps"],12)
                self.assertEqual(initial["initial_coins_each"],10000)
                self.assertEqual(initial["mode"],"FIXED_SYNTHETIC_CHALLENGE_NOT_VALIDATION")
                self.assertEqual(initial["has_overall_winner"],False)
                self.assertAlmostEqual(initial["uniform_baseline_brier"],2/3,places=6)
                self.assertEqual(len(initial["actual_labels"]),12)
                for slot in SLOTS:
                    obj=initial["contestants"][slot]
                    self.assertEqual(len(obj["history"]),12)
                    self.assertEqual(len(obj["equity_path"]),13)
                    self.assertTrue(0 <= obj["accuracy_pct"] <= 100)
                    self.assertTrue(0 <= obj["brier_mean"] <= 2)
                    self.assertTrue(0 <= obj["max_drawdown_pct"] <= 100)
                    self.assertAlmostEqual(
                        obj["brier_mean"],
                        sum(row["brier"] for row in obj["history"])/12, places=5
                    )
                    self.assertEqual(
                        [x["actual"] for x in obj["history"]],
                        initial["actual_labels"],
                    )
                    for item in obj["history"]:
                        self.assertAlmostEqual(sum(item["prediction"].values()),1.0,places=5)
                    self.assertEqual(set(obj["ranks"]),{"brier","profit","drawdown"})
                    self.assertTrue(all(1 <= x <= 3 for x in obj["ranks"].values()))

    def test_only_past_prices_visible_to_model(self):
        case=SCENARIOS["falling"]["prices"]
        observed=[]
        builtin_prediction=prediction
        def inspection(model, prices):
            # For each character, predictions must see the identical past prefix.
            idx=len(observed)%12
            expected=SYNTHETIC_PRICES+case[:idx]
            self.assertEqual(prices,expected)
            self.assertNotIn(case[idx:],(prices,))  # future cannot appear as whole input
            observed.append(idx)
            return builtin_prediction(model,prices)
        with patch("challenge.prediction",side_effect=inspection):
            run_challenge("falling",MODELS)
        self.assertEqual(observed,[i for _ in range(3) for i in range(12)])

    def test_reversed_future_cannot_affect_first_forecast(self):
        first = SCENARIOS["rising"]["prices"]
        altered=(first[0],)+tuple(reversed(first[1:]))
        left=_simulate(Model(),first)
        right=_simulate(Model(),altered)
        self.assertEqual(left["history"][0]["prediction"],right["history"][0]["prediction"])
        self.assertEqual(left["history"][0]["action"],right["history"][0]["action"])
        self.assertEqual(left["history"][1]["prediction"],right["history"][1]["prediction"])
        self.assertNotEqual(
            [row["observed_price"] for row in left["history"]],
            [row["observed_price"] for row in right["history"]],
        )

    def test_flat_label_cutoff_and_3class_brier(self):
        self.assertEqual(actual_direction(100,100.8),"FLAT")
        self.assertEqual(actual_direction(100,99.2),"FLAT")
        self.assertEqual(actual_direction(100,100.81),"UP")
        self.assertEqual(actual_direction(100,99.19),"DOWN")
        self.assertAlmostEqual(multiclass_brier("UP",{"UP":1,"FLAT":0,"DOWN":0}),0.0)
        with self.assertRaises(ValueError):
            actual_direction(float("nan"),100)
        with self.assertRaises(ValueError):
            actual_direction(100,0)

    def test_metric_rank_independent_and_ties(self):
        synthetic={
            "mine":{"brier_mean":.3,"profit_coins":12,"max_drawdown_pct":3},
            "owl":{"brier_mean":.2,"profit_coins":8,"max_drawdown_pct":3},
            "turtle":{"brier_mean":.2,"profit_coins":20,"max_drawdown_pct":1},
        }
        self.assertEqual(_rank(synthetic,"brier_mean",ascending=True),{"owl":1,"turtle":1,"mine":3})
        self.assertEqual(_rank(synthetic,"profit_coins",ascending=False),{"turtle":1,"mine":2,"owl":3})
        self.assertEqual(_rank(synthetic,"max_drawdown_pct",ascending=True),{"turtle":1,"mine":2,"owl":2})

    def test_invalid_inputs_fail_and_input_models_unchanged(self):
        mine=Model(4,13,.6,(20,30,10,40),(130,100,75,105))
        roster={"mine":mine,**PRESETS}
        before=dict(roster)
        answer=run_challenge("sideways",roster)
        self.assertEqual(roster,before)
        self.assertNotEqual(answer["contestants"]["mine"]["effective_sha256"],
                            answer["contestants"]["owl"]["effective_sha256"])
        for invalid in ("../private",None,"","RISING",42,[],True):
            with self.subTest(value=invalid):
                with self.assertRaises(ValueError):
                    run_challenge(invalid,roster)
        for invalid in ({},{"mine":Model()}, {"mine":Model(),"owl":Model(),"turtle":None}):
            with self.subTest(roster=invalid):
                with self.assertRaises(ValueError):
                    run_challenge("rising",invalid)

    def test_challenge_scores_three_independent_axes(self):
        result=run_challenge("rising",MODELS)
        players=result["contestants"]
        min_brier=min(x["brier_mean"] for x in players.values())
        max_profit=max(x["profit_coins"] for x in players.values())
        min_risk=min(x["max_drawdown_pct"] for x in players.values())
        self.assertEqual({k for k,v in players.items() if v["ranks"]["brier"]==1},
                         {k for k,v in players.items() if v["brier_mean"]==min_brier})
        self.assertEqual({k for k,v in players.items() if v["ranks"]["profit"]==1},
                         {k for k,v in players.items() if v["profit_coins"]==max_profit})
        self.assertEqual({k for k,v in players.items() if v["ranks"]["drawdown"]==1},
                         {k for k,v in players.items() if v["max_drawdown_pct"]==min_risk})


if __name__=="__main__":
    unittest.main()

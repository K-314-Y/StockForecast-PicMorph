import unittest
from challenge import baseline_predictions, run_challenge, SCENARIOS, KEYS
from engine import Model, multiclass_brier, prediction, SYNTHETIC_PRICES
from game import PRESETS

class BaselineTests(unittest.TestCase):
    def test_all_scenarios_and_comparisons(self):
        models={"mine":Model(),**PRESETS}
        for scenario,spec in SCENARIOS.items():
            result=run_challenge(scenario,models)
            for key,base in result["baselines"].items():
                self.assertEqual(len(base["history"]),12)
                counts=dict.fromkeys(KEYS,1)
                scores=[]
                for row in base["history"]:
                    pred=row["prediction"]
                    self.assertAlmostEqual(sum(pred.values()),1)
                    expected=dict.fromkeys(KEYS,1/3) if key=="uniform" else {k:counts[k]/sum(counts.values()) for k in KEYS}
                    self.assertEqual(pred,expected)
                    self.assertEqual(row["brier"],multiclass_brier(row["actual"],pred))
                    scores.append(row["brier"])
                    counts[row["actual"]]+=1
                self.assertEqual(base["history"][0]["prediction"],dict.fromkeys(KEYS,1/3))
                self.assertEqual(base["brier_mean"],sum(scores)/12)
                if key=="uniform":
                    for score in scores:self.assertAlmostEqual(score,2/3)
                for slot,model in models.items():
                    exact=[multiclass_brier(label,prediction(model,SYNTHETIC_PRICES+spec["prices"][:i])) for i,label in enumerate(result["actual_labels"])]
                    comparison=result["contestants"][slot]["baseline_comparison"][key]
                    self.assertEqual(comparison["mean_difference"],sum(exact)/12-base["brier_mean"])
                    self.assertEqual(comparison["won_steps"],sum(a<b-1e-12 for a,b in zip(exact,scores)))

    def test_no_current_or_future_label_leak(self):
        labels=["UP","FLAT","DOWN"]*4
        for index in range(12):
            changed=labels[:index]+["DOWN" if v!="DOWN" else "UP" for v in labels[index:]]
            before,after=baseline_predictions(labels),baseline_predictions(changed)
            for key in before:
                for step in range(index+1):
                    self.assertEqual(before[key]["history"][step]["prediction"],after[key]["history"][step]["prediction"])

    def test_uniform_ties_are_not_wins(self):
        from unittest.mock import patch
        with patch("challenge.prediction",return_value=dict.fromkeys(KEYS,1/3)):
            result=run_challenge("sideways",{"mine":Model(),**PRESETS})
        for item in result["contestants"].values():
            self.assertEqual(item["baseline_comparison"]["uniform"]["won_steps"],0)
            self.assertEqual(item["baseline_comparison"]["uniform"]["mean_difference"],0)

"""Read-only compatibility oracle: Python model signals and legacy game outputs.

Used only by Node unit tests during JS migration, never by the gameplay
JavaScript module at runtime. Does not read local_state or call HTTP.
"""
import hashlib
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import Model, PLUGIN_IDS, SYNTHETIC_PRICES, prediction, python_source
from game import PRESETS, PRACTICE_PATH, INITIAL_COINS, FEE_RATE, run_practice


def fixture(current, allocations, overrides=None):
    overrides = overrides or {}
    models = {"mine": current, **PRESETS, **overrides}
    prior = list(SYNTHETIC_PRICES)
    signals = []
    for next_price in PRACTICE_PATH:
        row = {}
        for key, model in models.items():
            p = prediction(model, tuple(prior))
            row[key] = ("LONG" if p["UP"] > .52 and p["UP"] > p["DOWN"] + .05 else "CASH")
        signals.append(row)
        prior.append(next_price)
    game_plan = {
        "mode": "PRACTICE_SYNTHETIC_ONLY",
        "allocations": allocations,
        "initial_coins": INITIAL_COINS,
        "fee_rate": FEE_RATE,
        "initial_price": SYNTHETIC_PRICES[-1],
        "future_prices": list(PRACTICE_PATH),
        "signals": signals,
        "models": {
            key: {
                "risk_fraction": model.risk_fraction,
                "plugin_weights": dict(zip(PLUGIN_IDS, model.plugin_weights)),
                "plugin_strengths": dict(zip(PLUGIN_IDS, model.plugin_strengths)),
                "effective_sha256": hashlib.sha256(python_source(model).encode()).hexdigest(),
            }
            for key, model in models.items()
        },
        "model_sha256": hashlib.sha256(python_source(current).encode()).hexdigest(),
    }
    return {
        "plan": game_plan,
        "expected": run_practice(current, allocations, assigned=models),
    }


cases = {
    "default": fixture(Model(), {"mine":40, "owl":30, "turtle":20}),
    "solo": fixture(Model(), {"mine":100, "owl":0, "turtle":0}),
    "zero": fixture(Model(), {"mine":0, "owl":0, "turtle":0}),
    "changed_model": fixture(
        Model(3, 9, .35, (20,70,10,0)),
        {"mine":50, "owl":25, "turtle":25},
        {"owl":Model(5,12,.50), "turtle":Model(8,20,.25)},
    ),
}
print(json.dumps(cases, ensure_ascii=False, allow_nan=False))

"""Model-only, one-shot offline predictor. Reads JSON stdin, writes JSON stdout.

No gameplay, no XP, no accounts, no network, no V6 access or disk writes.
Node supplies trusted validated model settings fetched from local Python core.
The predicted direction is computed BEFORE future synthetic price is revealed.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import Model, PLUGIN_IDS, SYNTHETIC_PRICES, prediction, python_source
from game_runtime.accessory_analysis import METHODS, RULE_VERSION, accessory_signal

SLOTS = ("mine", "owl", "turtle")
FUTURE = (107, 106, 104, 101, 100, 104, 108, 112, 110, 114, 113, 117)


def model_from_record(data: dict) -> Model:
    if type(data) is not dict or set(data) != {
        "fast_window", "slow_window", "risk_fraction", "plugin_weights", "plugin_strengths"
    }:
        raise ValueError("invalid_model_structure")
    weights, strengths = data["plugin_weights"], data["plugin_strengths"]
    if (type(weights) is not dict or set(weights) != set(PLUGIN_IDS)
            or type(strengths) is not dict or set(strengths) != set(PLUGIN_IDS)):
        raise ValueError("invalid_model_plugins")
    return Model(
        data["fast_window"], data["slow_window"], data["risk_fraction"],
        tuple(weights[k] for k in PLUGIN_IDS),
        tuple(strengths[k] for k in PLUGIN_IDS),
    )


def scenario_prices(token: str) -> tuple:
    """v1 fictional statistics, not realistic markets or a market backtest.

    Index 0..11; full SHA256 big-endian modulo 701 minus 350 bps.
    Integer cents round half up each day; independent of models.
    Public replay identifiers are not secrets or authentication.
    """
    if type(token) is not str or re.fullmatch(r"v1_[0-9a-f]{16}", token) is None:
        raise ValueError("invalid_scenario_token")
    cents = 10900  # v1 freezes SYNTHETIC_PRICES[-1] = 109.00
    prices = []
    for index in range(12):
        digest = hashlib.sha256(f"{token}:{index}".encode("ascii")).digest()
        bps = int.from_bytes(digest, "big") % 701 - 350
        cents = (cents * (10000 + bps) + 5000) // 10000
        prices.append(cents / 100)
    return tuple(prices)


def create_prediction_plan(data: dict) -> dict:
    optional = {"scenario_token", "accessory_strategy"}
    if (type(data) is not dict or not {"base_model", "models"}.issubset(data)
            or not (set(data) - {"base_model", "models"}).issubset(optional)
            or type(data["models"]) is not dict or set(data["models"]) != set(SLOTS)):
        raise ValueError("invalid_prediction_request")
    accessory = data.get("accessory_strategy")
    if "accessory_strategy" in data and (type(accessory) is not str or accessory not in METHODS):
        raise ValueError("invalid_accessory_strategy")
    base = model_from_record(data["base_model"])
    models = {key: model_from_record(data["models"][key]) for key in SLOTS}
    future = scenario_prices(data["scenario_token"]) if "scenario_token" in data else FUTURE
    history = list(SYNTHETIC_PRICES)
    signals = []
    for next_price in future:
        step = {}
        for key in SLOTS:
            p = prediction(models[key], tuple(history))
            if key == "mine" and accessory is not None:
                step[key] = accessory_signal(accessory, tuple(history), p["UP"])
            else:
                step[key] = "LONG" if p["UP"] > .52 and p["UP"] > p["DOWN"] + .05 else "CASH"
        signals.append(step)
        history.append(next_price)
    return {
        "mode": "PRACTICE_SYNTHETIC_ONLY",
        "initial_coins": 10000,
        "fee_rate": .001,
        "initial_price": SYNTHETIC_PRICES[-1],
        "future_prices": list(future),
        "signals": signals,
        "models": {k: {
            "risk_fraction": m.risk_fraction,
            "plugin_weights": dict(zip(PLUGIN_IDS, m.plugin_weights)),
            "plugin_strengths": dict(zip(PLUGIN_IDS, m.plugin_strengths)),
            "effective_sha256": hashlib.sha256((
                python_source(m) + (
                    "\n" + RULE_VERSION + ":" + accessory if k == "mine" and accessory else ""
                )).encode()).hexdigest(),
        } for k, m in models.items()},
        "model_sha256": hashlib.sha256(python_source(base).encode()).hexdigest(),
    }


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError("request_too_large")
        result = create_prediction_plan(json.loads(raw))
        sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False))
    except (ValueError, TypeError, KeyError) as exc:
        print("forecast plan rejected:", str(exc), file=sys.stderr)
        sys.exit(1)

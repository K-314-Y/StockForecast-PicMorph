"""Offline P9ag research fixtures. Run via benchmark-accessory-regimes.mjs."""
import hashlib
import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from game_runtime import predict_bridge as bridge

SEED = "P9ag-20261125-v1"
SETS = ("development", "validation")
TYPES = ("up", "down", "flat", "recovery", "cluster", "reversal")
COUNT = 60
MODEL = {
    "fast_window": 3, "slow_window": 9, "risk_fraction": .35,
    "plugin_weights": {"trend": 100, "momentum": 0, "reversion": 0, "volatility": 0},
    "plugin_strengths": dict.fromkeys(bridge.PLUGIN_IDS, 100),
}
OPTIONS = {
    "standard": {}, **{name: {"accessory_strategy": name} for name in bridge.METHODS},
    "triple": {"accessory_methods": [bridge.METHODS[s] for s in ("star", "glasses", "ribbon")]},
}


def prices(split, regime, index):
    def draw(key, modulus):
        key = f"{SEED}/{split}/{regime}/{index}/{key}"
        return int.from_bytes(hashlib.sha256(key.encode("ascii")).digest(), "big") % modulus

    def noise(day, amplitude):
        return draw(day, 2 * amplitude + 1) - amplitude

    cents = 10900
    high = draw("state", 2)
    shock = 2 + draw("shock", 3)
    turn = 5 + draw("turn", 3)
    direction = 1 if index % 2 == 0 else -1
    path = []
    for day in range(12):
        if regime in ("up", "down"):
            drift = 110 if regime == "up" else -110
            bps = drift + noise(day, 180)
        elif regime == "flat":
            bps = (10900 - cents) * 5000 // cents + noise(day, 110)
        elif regime == "recovery":
            drift = 0 if day < shock else -900 if day == shock else 140
            bps = drift + noise(day, 80 if day <= shock else 100)
        elif regime == "cluster":
            if day and draw(f"flip-{day}", 5) == 0:
                high = not high
            bps = noise(day, 450 if high else 50)
        elif regime == "reversal":
            bps = direction * (160 if day < turn else -160) + noise(day, 120)
        else:
            raise ValueError(regime)
        cents = (cents * (10000 + bps) + 5000) // 10000
        path.append(cents / 100)
    return tuple(path)


def request(strategy):
    return {"base_model": MODEL, "models": dict.fromkeys(bridge.SLOTS, MODEL), **OPTIONS[strategy]}


def plans(path):
    # Scope the replay input override to this single-process research call.
    for strategy in OPTIONS:
        with patch.object(bridge, "FUTURE", path):
            plan = bridge.create_prediction_plan(request(strategy))
        plan.update(initial_coins=1000, allocations={"mine": 100, "owl": 0, "turtle": 0})
        yield strategy, plan


if __name__ == "__main__":
    split, regime = sys.argv[1:]
    if split not in SETS or regime not in TYPES:
        raise ValueError((split, regime))
    for i in range(COUNT):
        print(json.dumps(dict(plans(prices(split, regime, i))), separators=(",", ":")))

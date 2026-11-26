"""S106 test-only fixture. Never reads market data or registered user settings."""
from copy import deepcopy
from datetime import date, timedelta
from hashlib import sha256
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "mcp"), str(ROOT / "game_runtime"), str(ROOT)]
from accessory_registration_store import canonical, check_record, REVISIONS
from accessory_evaluation_readiness import PROTOCOL_V1_SHA
from market_replay import parse_models, replay_window
import market_replay

PROTOCOL_PATH = ROOT / "game_runtime/accessory-registration-protocol-v1.json"
VARIANTS = ("paired", "identical", "last-close-shock")


def fixture(variant):
    if variant not in VARIANTS:
        raise ValueError("unknown synthetic fixture")
    protocol = json.loads(PROTOCOL_PATH.read_bytes())
    assert sha256(canonical(protocol)).hexdigest() == PROTOCOL_V1_SHA
    baseline = {"fast_window": 4, "slow_window": 10, "risk_fraction": .35,
                "plugin_weights": {"trend": 40, "momentum": 20, "reversion": 25, "volatility": 15},
                "plugin_strengths": {"trend": 110, "momentum": 90, "reversion": 105, "volatility": 100}}
    candidate = deepcopy(baseline)
    if variant != "identical":
        candidate["plugin_weights"] = {"trend": 31, "momentum": 38, "reversion": 19, "volatility": 12}
    record = {"schema": 1, "registered_jst_day": "2025-02-04", "earliest_possible_day": "2025-02-05",
              "created_at": "2025-02-04T01:02:03.004Z",
              "context": {"character_id": "cp_" + "a"*32, "active_revision": 1,
                          "equipment_revision": 1, "expected_revision": 1},
              "source_revisions": dict.fromkeys(REVISIONS, 1),
              "base_model": baseline, "baseline": baseline, "candidate": candidate,
              "applied_rules": [{"kind_id": "fixture.pin", "focus": "momentum", "intensity": 3}],
              "visible_kinds": ["fixture.pin"],
              "source_sha256": {name: sha256((ROOT / name).read_bytes()).hexdigest()
                                for name in protocol["source_files"]},
              "protocol": protocol, "timestamp_basis": "local_system_clock",
              "status": "pending_no_verified_data"}
    raw = canonical(record)
    identifier = sha256(raw).hexdigest()
    checked, _ = check_record(raw, identifier + ".json", protocol)
    base, models = parse_models(checked["base_model"],
        {"mine": checked["candidate"], "owl": checked["baseline"], "turtle": checked["baseline"]})
    # Weekday labels are fictional, not a claim about the exchange calendar.
    cutoff = date.fromisoformat(checked["registered_jst_day"])
    dates = [cutoff + timedelta(days=i) for i in range(-50, 30)
             if (cutoff + timedelta(days=i)).weekday() < 5]
    dates = [d.isoformat() for d in ([d for d in dates if d <= cutoff][-24:] +
                                     [d for d in dates if d > cutoff][:12])]
    windows, traces = [], []
    source = {"origin": "SYNTHETIC_S106_FIXTURE", "source": "generated test prices only",
              "adjusted": False, "warning": "Not market data or forward validation."}
    for index, code in enumerate(protocol["codes"]):
        cents = 10000 + index * 100
        prices = []
        for step in range(36):
            # Deterministic varying trend and reversals; independent of either model.
            bps = (340 if (step + index * 2) % 24 < 12 else -300) + ((step * 37 + index * 19) % 91 - 45)
            cents = (cents * (10000 + bps) + 5000) // 10000
            prices.append(cents / 100)
        if variant == "last-close-shock":
            prices[-1] *= 1.8
        selected = list(zip(dates, prices))
        trace = []
        original = market_replay.prediction
        def traced(model, history):
            probabilities = original(model, history)
            trace.append({"history": list(history), "probabilities": probabilities})
            return probabilities
        market_replay.prediction = traced
        try:
            windows.append(replay_window(source, len(protocol["codes"]),
                ("mkt_" + sha256(code.encode()).hexdigest()[:24], code, selected), base, models))
        finally:
            market_replay.prediction = original
        # Every prediction must see precisely the prefix available before its outcome.
        factor = 100 / prices[23]
        indexed = [round(p * factor, 6) for p in prices]
        assert len(trace) == 36
        for step in range(12):
            assert all(row["history"] == indexed[:24+step] for row in trace[step*3:step*3+3])
        traces.append([row["probabilities"] for row in trace])
    assert canonical(checked) == raw
    assert all(sha256((ROOT / name).read_bytes()).hexdigest() == digest
               for name, digest in checked["source_sha256"].items())
    return {"scope": "SYNTHETIC_S106_FIXTURE_ONLY", "real_market_history": False,
            "score_allowed": False, "holdout_evaluated": False, "fixture_sha256": identifier,
            "frozen_models": {key: checked[key] for key in ("base_model", "baseline", "candidate")},
            "windows": windows, "probability_traces": traces}


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in VARIANTS:
        raise SystemExit("Select a built-in synthetic fixture only.")
    print(json.dumps(fixture(sys.argv[1]), allow_nan=False))

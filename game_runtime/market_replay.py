"""Pure historical replay maths for in-memory close prices."""

from hashlib import sha256

if __package__:
    from .predict_bridge import model_from_record, SLOTS
else:
    from predict_bridge import model_from_record, SLOTS
from engine import PLUGIN_IDS, prediction, multiclass_brier, python_source

LOOKBACK, HORIZON = 24, 12


def parse_models(base, models):
    if not isinstance(models, dict) or set(models) != set(SLOTS):
        raise ValueError("invalid_model_slots")
    return model_from_record(base), {slot: model_from_record(models[slot]) for slot in SLOTS}


def replay_window(source, eligible_count, window, base, models):
    wid, code, selected = window
    # Convert to a 100-based price index using only the final *observed* day.
    factor = 100 / selected[LOOKBACK - 1][1]
    prices = [round(value[1] * factor, 6) for value in selected]
    history, future = prices[:LOOKBACK], prices[LOOKBACK:]
    signals = []
    brier_total = {slot: 0.0 for slot in SLOTS}
    for next_close in future:
        predicted = {}
        actual_change = next_close / history[-1] - 1
        actual = "UP" if actual_change > .003 else ("DOWN" if actual_change < -.003 else "FLAT")
        for slot, model in models.items():
            probabilities = prediction(model, tuple(history))
            predicted[slot] = ("LONG" if probabilities["UP"] > .52 and
                               probabilities["UP"] > probabilities["DOWN"] + .05 else "CASH")
            brier_total[slot] += multiclass_brier(actual, probabilities)
        signals.append(predicted)
        history.append(next_close)
    first_date, final_date = selected[0][0], selected[-1][0]
    return {
        "mode": "HISTORICAL_MARKET_REPLAY_ONLY",
        "source_origin": source["origin"], "source": source["source"],
        "adjusted": source["adjusted"], "source_warning": source["warning"],
        "market_id": wid, "code": code, "start_date": first_date,
        "history_end_date": selected[LOOKBACK-1][0],
        "end_date": final_date, "lookback_days": LOOKBACK,
        "future_days": HORIZON, "eligible_windows": eligible_count,
        "price_index_base": 100, "flat_threshold_pct": .3,
        "brier": {k: round(v / HORIZON, 6) for k, v in brier_total.items()},
        "plan": {
            "mode": "PRACTICE_SYNTHETIC_ONLY",  # JS economy simulation protocol, not data origin
            "initial_coins": 10000, "fee_rate": .001,
            "initial_price": prices[LOOKBACK-1],
            "future_prices": future, "signals": signals,
            "models": {k: {
                "risk_fraction": m.risk_fraction,
                "plugin_weights": dict(zip(PLUGIN_IDS, m.plugin_weights)),
                "plugin_strengths": dict(zip(PLUGIN_IDS, m.plugin_strengths)),
                "effective_sha256": sha256(python_source(m).encode()).hexdigest(),
            } for k, m in models.items()},
            "model_sha256": sha256(python_source(base).encode()).hexdigest(),
        },
    }

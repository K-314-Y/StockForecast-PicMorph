"""Sprint 8: reproducible, offline challenge evaluation.

This is an instructional comparison on *fixed, synthetic scenarios*, not an
out-of-sample investment backtest. No ranking by combined score. Each strategy
sees only the price prefix through its decision timestamp.

A new challenge always starts with the same fictional 10,000 coin budget for
*each* of the three contestants; it never spends XP or transfers coins.
"""
from __future__ import annotations

import hashlib
import json
import math

from engine import Model, SYNTHETIC_PRICES, multiclass_brier, prediction, python_source
from game import FEE_RATE, INITIAL_COINS, SLOTS

# Kept in code, not generated in response to model behavior. The fixed paths
# are intentionally diverse, but have no claim of scientific representativeness.
SCENARIOS = {
    "rising": {
        "name": "上昇局面（架空）",
        "description": "緩やかな上昇と途中の押し目",
        "prices": (111, 113, 112, 115, 117, 119, 118, 120, 122, 123, 121, 125),
    },
    "falling": {
        "name": "下落局面（架空）",
        "description": "じわじわ下落して途中で一時反発",
        "prices": (107, 104, 102, 103, 99, 96, 97, 94, 92, 90, 92, 88),
    },
    "sideways": {
        "name": "レンジ局面（架空）",
        "description": "横ばい中心で上下に変動",
        "prices": (109, 109.4, 108.5, 109.1, 109.3, 108.8,
                   109.5, 109.1, 109.6, 108.7, 109.0, 109.4),
    },
}
FLAT_BAND = 0.008
KEYS = ("UP", "FLAT", "DOWN")
SLOTS_TITLE = {"mine": "あなたのキャラ", "owl": "ルナ", "turtle": "ミドリ"}


def actual_direction(start: float, end: float) -> str:
    """Classify the *next* synthetic move only, with one fixed neutral band."""
    if not all(type(x) in (int, float) and math.isfinite(x) and x > 0 for x in (start, end)):
        raise ValueError("架空価格が不正です")
    r = end / start - 1
    # 100 * 1.008 cannot be represented exactly in binary floats; treat
    # values equal to the documented boundary as FLAT.
    flat = abs(r) <= FLAT_BAND or math.isclose(abs(r), FLAT_BAND, rel_tol=0, abs_tol=1e-12)
    return "FLAT" if flat else "UP" if r > 0 else "DOWN"


def _simulate(model: Model, future: tuple[float, ...], *,
              price_history=SYNTHETIC_PRICES, scores=None) -> dict:
    if not isinstance(model, Model):
        raise ValueError("キャラのモデルが不正です")
    # The caller supplies an independent observed prefix. Never concatenate the
    # hidden path before invoking prediction; synthetic callers retain defaults.
    if not price_history or not future or not all(
        type(x) in (int, float) and math.isfinite(x) and x > 0
        for x in (*price_history, *future)
    ):
        raise ValueError("価格履歴が不正です")
    history = list(price_history)
    cash = float(INITIAL_COINS)
    units = 0.0
    fees = 0.0
    correct = 0
    briers = []
    equity_path = [float(INITIAL_COINS)]
    ledger = []
    trades = 0
    for step, observed_next in enumerate(future, 1):
        observed_now = history[-1]
        pred = prediction(model, tuple(history))
        predicted_class = max(KEYS, key=pred.__getitem__)
        direction = actual_direction(observed_now, observed_next)

        # Predict and choose an action BEFORE appending the next price.
        want_long = pred["UP"] > .52 and pred["UP"] > pred["DOWN"] + .05
        equity_before = cash + units * observed_now
        desired_value = equity_before * model.risk_fraction if want_long else 0.0
        held_value = units * observed_now
        if desired_value > held_value + 1e-8:
            gross = min(desired_value - held_value, cash / (1.0 + FEE_RATE))
            if gross > 1e-8:
                fee = gross * FEE_RATE
                cash -= gross + fee
                units += gross / observed_now
                fees += fee
                trades += 1
        elif held_value > desired_value + 1e-8:
            gross = held_value - desired_value
            fee = gross * FEE_RATE
            cash += gross - fee
            units -= gross / observed_now
            fees += fee
            trades += 1
        if cash < -1e-7 or units < -1e-7:
            raise RuntimeError("架空資金の計算が不正です")
        brier = multiclass_brier(direction, pred)
        briers.append(brier)
        if scores is not None:
            scores.append(brier)
        correct += predicted_class == direction
        history.append(observed_next)
        equity_path.append(cash + units * observed_next)
        ledger.append({
            "step": step, "observed_price": observed_now,
            "prediction": {k: round(pred[k], 6) for k in KEYS},
            "predicted": predicted_class, "actual": direction,
            "action": "LONG" if want_long else "CASH",
            "brier": round(brier, 6),
        })

    final = equity_path[-1]
    top = float(INITIAL_COINS)
    max_drawdown = 0.0
    for value in equity_path[1:]:
        top = max(top, value)
        max_drawdown = max(max_drawdown, 1.0 - value / top)
    return {
        "brier_mean": round(sum(briers) / len(briers), 6),
        "accuracy_pct": round(100.0 * correct / len(future), 2),
        "profit_coins": round(final - INITIAL_COINS, 2),
        "return_pct": round(100.0 * (final / INITIAL_COINS - 1.0), 3),
        "max_drawdown_pct": round(max_drawdown * 100.0, 3),
        "fee_coins": round(fees, 3),
        "trades": trades,
        "equity_path": [round(x, 2) for x in equity_path],
        "history": ledger,
        "effective_sha256": hashlib.sha256(python_source(model).encode()).hexdigest(),
    }


def baseline_predictions(labels: list[str]) -> dict:
    """Predict before observing each challenge label; no warm-up labels."""
    counts = dict.fromkeys(KEYS, 1)
    result = {key: {"name": name, "history": []} for key, name in
              (("uniform", "均等予測"), ("past_frequency", "過去頻度"))}
    for step, actual in enumerate(labels, 1):
        probabilities = {
            "uniform": dict.fromkeys(KEYS, 1 / 3),
            "past_frequency": {k: counts[k] / sum(counts.values()) for k in KEYS},
        }
        for key, pred in probabilities.items():
            result[key]["history"].append({
                "step": step, "prediction": pred, "actual": actual,
                "brier": multiclass_brier(actual, pred),
            })
        counts[actual] += 1
    for item in result.values():
        item["brier_mean"] = sum(r["brier"] for r in item["history"]) / len(labels)
    return result


def _rank(players: dict, key: str, *, ascending: bool) -> dict[str, int]:
    """Competition ranking. Identical reported values receive the same rank."""
    names = sorted(SLOTS, key=lambda k: players[k][key], reverse=not ascending)
    ranks = {}
    previous = None
    current_rank = 0
    for position, name in enumerate(names, 1):
        value = players[name][key]
        if previous is None or value != previous:
            current_rank = position
        ranks[name] = current_rank
        previous = value
    return ranks


def compare_prices(price_history: tuple[float, ...], path: tuple[float, ...],
                   models: dict[str, Model]) -> dict:
    """Shared scoring/coin rules; forecasts receive only the observed prefix."""
    if not isinstance(models, dict) or set(models) != set(SLOTS) or any(
        not isinstance(models[k], Model) for k in SLOTS
    ):
        raise ValueError("3体分の予測モデルを指定してください")
    exact_scores = {name: [] for name in SLOTS}
    contestants = {name: _simulate(models[name], path, price_history=price_history,
                                   scores=exact_scores[name]) for name in SLOTS}
    ranks = {
        "brier": _rank(contestants, "brier_mean", ascending=True),
        "profit": _rank(contestants, "profit_coins", ascending=False),
        "drawdown": _rank(contestants, "max_drawdown_pct", ascending=True),
    }
    for name in SLOTS:
        contestants[name]["name"] = SLOTS_TITLE[name]
        contestants[name]["ranks"] = {key: values[name] for key, values in ranks.items()}

    # Same labels for every contestant, irrespective of strategies or actions.
    labels = [actual_direction(old, new) for old, new in zip(
        (price_history[-1],) + path[:-1], path
    )]
    baselines = baseline_predictions(labels)
    for name in SLOTS:
        exact = exact_scores[name]
        contestants[name]["baseline_comparison"] = {
            key: {
                "mean_difference": sum(exact) / len(exact) - baseline["brier_mean"],
                "won_steps": sum(score < row["brier"] - 1e-12
                                 for score, row in zip(exact, baseline["history"])),
            } for key, baseline in baselines.items()
        }
    baseline_brier = sum(multiclass_brier(x, dict.fromkeys(KEYS, 1 / 3)) for x in labels) / len(labels)
    return {
        "steps": len(path),
        "flat_threshold_pct": FLAT_BAND * 100,
        "initial_coins_each": INITIAL_COINS,
        "baselines": baselines,
        "uniform_baseline_brier": round(baseline_brier, 6),
        "actual_labels": labels,
        "contestants": contestants,
        "score_axes": {
            "brier": "低いほど良い。未来の架空ラベルに対する確率予測の二乗誤差平均",
            "profit": "高いほど良い。架空コインの損益で、手数料を含む",
            "drawdown": "低いほど良い。架空資金の最大ピーク比下落率",
        },
        "has_overall_winner": False,
    }


def run_challenge(scenario_id: object, models: dict[str, Model]) -> dict:
    if type(scenario_id) is not str or scenario_id not in SCENARIOS:
        raise ValueError("対応していない架空チャレンジです")
    scenario = SCENARIOS[scenario_id]
    path = scenario["prices"]
    return {
        **compare_prices(SYNTHETIC_PRICES, path, models),
        "mode": "FIXED_SYNTHETIC_CHALLENGE_NOT_VALIDATION",
        "scenario_id": scenario_id,
        "scenario_name": scenario["name"],
        "description": scenario["description"],
        "scenario_sha256": hashlib.sha256(json.dumps(path).encode()).hexdigest(),
        "warning": "架空の固定12ステップのみ。繰り返し調整で容易に過剰適合するため、現実の予測性能や投資判断には使用できません。",
    }


def public_scenarios() -> list[dict]:
    return [{
        "id": key, "name": value["name"], "description": value["description"],
        "steps": len(value["prices"])
    } for key, value in SCENARIOS.items()]

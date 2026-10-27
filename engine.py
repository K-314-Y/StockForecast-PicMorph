"""Creatures are editable *declarative* models, never executable user plugins.

Every indicator sees supplied synthetic history only. All calculations are
deterministic and side-effect free. Real market feeds and arbitrary code are out
of scope; user-facing "plugin" means one of these allowlisted functions.
"""
from __future__ import annotations

import ast
import hashlib
import math
from dataclasses import dataclass
from typing import Any

SYNTHETIC_PRICES = (
    100, 101, 102, 101, 103, 102, 100, 99, 100, 102,
    105, 106, 104, 102, 101, 100, 99, 98, 100, 101,
    103, 104, 106, 105, 103, 101, 100, 99, 98, 97,
    96, 98, 99, 101, 103, 102, 104, 107, 106, 109,
)
EYES = {"falcon": (3, 9), "owl": (5, 12), "turtle": (8, 20)}
PLUGIN_IDS = ("trend", "momentum", "volatility")
PLUGIN_INFO = (
    {"id": "trend", "name": "トレンド", "description": "2本の移動平均で方向を判定", "accessory": "lens"},
    {"id": "momentum", "name": "モメンタム", "description": "直近の価格変化で方向を判定", "accessory": "spark"},
    {"id": "volatility", "name": "ボラティリティ", "description": "直近の変動幅から横ばい確率を推定", "accessory": "halo"},
)
DEFAULT_WEIGHTS = (100, 0, 0)


@dataclass(frozen=True)
class Model:
    fast_window: int = 3
    slow_window: int = 9
    risk_fraction: float = 0.35
    plugin_weights: tuple[int, int, int] = DEFAULT_WEIGHTS

    def __post_init__(self) -> None:
        if type(self.fast_window) is not int or type(self.slow_window) is not int:
            raise ValueError("期間は整数で指定してください")
        if not (2 <= self.fast_window < self.slow_window <= 20):
            raise ValueError("期間は 2 <= FAST < SLOW <= 20 にしてください")
        if type(self.risk_fraction) not in (int, float) or not math.isfinite(self.risk_fraction):
            raise ValueError("リスク比率は有限の数値で指定してください")
        if not (0.05 <= self.risk_fraction <= 1.0):
            raise ValueError("リスク比率は 0.05〜1.0 にしてください")
        if not isinstance(self.plugin_weights, tuple) or len(self.plugin_weights) != 3 or any(
            type(w) is not int or not 0 <= w <= 100 for w in self.plugin_weights
        ) or sum(self.plugin_weights) != 100:
            raise ValueError("プラグイン重みは0〜100の整数で合計100%にしてください")


# Original source format is retained solely for validating Sprint-3 snapshots.
# This trusted legacy template is never exposed as executable user input.
LEGACY_SOURCE_TEMPLATE = '''# Sprint 1: constants can be edited. Arbitrary Python is NOT executed.
FAST_WINDOW = {fast}
SLOW_WINDOW = {slow}
RISK_FRACTION = {risk}

def forecast(prices):
    fast = sum(prices[-FAST_WINDOW:]) / FAST_WINDOW
    slow = sum(prices[-SLOW_WINDOW:]) / SLOW_WINDOW
    momentum = (fast / slow) - 1
    strength = max(-1.0, min(1.0, momentum / 0.06))
    flat = 0.20 + 0.20 * (1.0 - abs(strength))
    up = (1.0 - flat) * (strength + 1.0) / 2.0
    down = 1.0 - flat - up
    return {{"UP": up, "FLAT": flat, "DOWN": down}}
'''

SOURCE_TEMPLATE = '''# Declarative indicator composition. Only numeric constants are editable.
# All three indicators use the same past prices, not future candles.
FAST_WINDOW = {fast}
SLOW_WINDOW = {slow}
RISK_FRACTION = {risk}
WEIGHT_TREND = {trend}
WEIGHT_MOMENTUM = {momentum}
WEIGHT_VOLATILITY = {volatility}

def forecast(prices):
    fast = sum(prices[-FAST_WINDOW:]) / FAST_WINDOW
    slow = sum(prices[-SLOW_WINDOW:]) / SLOW_WINDOW
    delta = fast / slow - 1.0
    strength = max(-1.0, min(1.0, delta / 0.06))
    flat_t = 0.20 + 0.20 * (1.0 - abs(strength))
    up_t = (1.0 - flat_t) * (strength + 1.0) / 2.0

    roc = prices[-1] / prices[-FAST_WINDOW - 1] - 1.0
    mom = max(-1.0, min(1.0, roc / 0.08))
    flat_m = 0.15 + 0.25 * (1.0 - abs(mom))
    up_m = (1.0 - flat_m) * (mom + 1.0) / 2.0

    recent = prices[-SLOW_WINDOW:]
    vol = sum(abs(recent[i] / recent[i-1] - 1.0) for i in range(1, len(recent))) / (len(recent) - 1)
    flat_v = max(0.15, min(0.60, 0.60 - 10.0 * vol))
    up_v = (1.0 - flat_v) / 2.0

    up = (WEIGHT_TREND * up_t + WEIGHT_MOMENTUM * up_m + WEIGHT_VOLATILITY * up_v) / 100
    flat = (WEIGHT_TREND * flat_t + WEIGHT_MOMENTUM * flat_m + WEIGHT_VOLATILITY * flat_v) / 100
    return {{"UP": up, "FLAT": flat, "DOWN": max(0.0, 1.0 - up - flat)}}
'''


def _format(source_template: str, model: Model) -> str:
    return source_template.format(
        fast=model.fast_window, slow=model.slow_window,
        risk=format(model.risk_fraction, ".4g"),
        trend=model.plugin_weights[0], momentum=model.plugin_weights[1],
        volatility=model.plugin_weights[2],
    )


def python_source(model: Model) -> str:
    return _format(SOURCE_TEMPLATE, model)


def legacy_python_source(model: Model) -> str:
    return _format(LEGACY_SOURCE_TEMPLATE, model)


def model_from_python(source: str) -> Model:
    """Accept only numeric constants and an AST-identical known forecast function.

    Never eval, compile, exec, or import the user's submitted source.
    """
    if not isinstance(source, str) or len(source) > 6000:
        raise ValueError("ソースコードのサイズが不正です")
    try:
        parsed = ast.parse(source)
    except SyntaxError as exc:
        raise ValueError("Pythonの構文を確認してください") from exc
    expected = ast.parse(python_source(Model()))
    names = (
        "FAST_WINDOW", "SLOW_WINDOW", "RISK_FRACTION",
        "WEIGHT_TREND", "WEIGHT_MOMENTUM", "WEIGHT_VOLATILITY",
    )
    if len(parsed.body) != len(expected.body):
        raise ValueError("試作版では数値定数の編集のみ対応しています")
    assignments = {}
    for index, name in enumerate(names):
        node = parsed.body[index]
        if (not isinstance(node, ast.Assign) or len(node.targets) != 1
            or not isinstance(node.targets[0], ast.Name) or node.targets[0].id != name
            or not isinstance(node.value, ast.Constant)
            or type(node.value.value) not in (int, float)):
            raise ValueError("定数の名前と数値だけ変更できます")
        assignments[name] = node.value.value
    for index in range(len(names), len(parsed.body)):
        if ast.dump(parsed.body[index], include_attributes=False) != ast.dump(
            expected.body[index], include_attributes=False
        ):
            raise ValueError("予測関数本体の変更はこの試作版ではできません")
    return Model(
        fast_window=assignments["FAST_WINDOW"],
        slow_window=assignments["SLOW_WINDOW"],
        risk_fraction=assignments["RISK_FRACTION"],
        plugin_weights=tuple(assignments["WEIGHT_" + key.upper()] for key in PLUGIN_IDS),
    )


def with_visual_change(current: Model, *, eye: str | None = None, risk: Any = None) -> Model:
    if eye is not None and eye not in EYES:
        raise ValueError("未知の目の装備です")
    fast, slow = EYES[eye] if eye is not None else (
        current.fast_window, current.slow_window
    )
    return Model(fast, slow, current.risk_fraction if risk is None else risk,
                 current.plugin_weights)


def with_plugin_change(current: Model, weights: object) -> Model:
    if not isinstance(weights, dict) or set(weights) != set(PLUGIN_IDS):
        raise ValueError("登録済みの3つのプラグイン重みを指定してください")
    return Model(current.fast_window, current.slow_window,
                 current.risk_fraction, tuple(weights[k] for k in PLUGIN_IDS))


def prediction_components(model: Model, prices: tuple[int, ...] = SYNTHETIC_PRICES) -> dict[str, dict[str, float]]:
    if len(prices) < model.slow_window or not all(
        type(v) in (int, float) and math.isfinite(v) and v > 0 for v in prices
    ):
        raise ValueError("利用できる合成データが不足しています")
    fast = sum(prices[-model.fast_window:]) / model.fast_window
    slow = sum(prices[-model.slow_window:]) / model.slow_window
    delta = fast / slow - 1.0
    strength = max(-1.0, min(1.0, delta / .06))
    flat_t = .20 + .20 * (1.0 - abs(strength))
    up_t = (1.0 - flat_t) * (strength + 1.0) / 2.0

    roc = prices[-1] / prices[-model.fast_window - 1] - 1.0
    mom = max(-1.0, min(1.0, roc / .08))
    flat_m = .15 + .25 * (1.0 - abs(mom))
    up_m = (1.0 - flat_m) * (mom + 1.0) / 2.0

    recent = prices[-model.slow_window:]
    vol = sum(abs(recent[i] / recent[i-1] - 1.0)
              for i in range(1, len(recent))) / (len(recent) - 1)
    flat_v = max(.15, min(.60, .60 - 10.0 * vol))
    up_v = (1.0 - flat_v) / 2.0
    return {
        "trend": {"UP": up_t, "FLAT": flat_t, "DOWN": max(0.0, 1.0 - up_t - flat_t)},
        "momentum": {"UP": up_m, "FLAT": flat_m, "DOWN": max(0.0, 1.0 - up_m - flat_m)},
        "volatility": {"UP": up_v, "FLAT": flat_v, "DOWN": max(0.0, 1.0 - up_v - flat_v)},
    }


def prediction(model: Model, prices: tuple[int, ...] = SYNTHETIC_PRICES) -> dict[str, float]:
    parts = prediction_components(model, prices)
    result = {
        key: sum(w * parts[name][key] / 100 for name, w in zip(PLUGIN_IDS, model.plugin_weights))
        for key in ("UP", "FLAT")
    }
    result["DOWN"] = max(0.0, 1 - result["UP"] - result["FLAT"])
    if not math.isclose(sum(result.values()), 1.0, abs_tol=1e-12):
        raise RuntimeError("確率が正規化されていません")
    if any(value < -1e-10 or value > 1+1e-10 for value in result.values()):
        raise RuntimeError("予測確率が範囲外です")
    return result


def multiclass_brier(actual: str, probabilities: dict[str, float]) -> float:
    if actual not in ("UP", "FLAT", "DOWN"):
        raise ValueError("結果の分類が不正です")
    if set(probabilities) != {"UP", "FLAT", "DOWN"} or any(
        not math.isfinite(v) or not (0 <= v <= 1) for v in probabilities.values()
    ):
        raise ValueError("確率が不正です")
    if not math.isclose(sum(probabilities.values()), 1, abs_tol=1e-9):
        raise ValueError("確率の合計が100%になっていません")
    return sum((probabilities[key] - int(actual == key)) ** 2 for key in probabilities)


def view(model: Model, revision: int = 0) -> dict[str, Any]:
    eye = next(
        (name for name, values in EYES.items()
         if values == (model.fast_window, model.slow_window)), "custom"
    )
    values = prediction(model)
    components = prediction_components(model)
    choice = max(("UP", "FLAT", "DOWN"), key=values.get)
    source = python_source(model)
    return {
        "revision": revision,
        "visual": {
            "eye": eye,
            "eye_intensity": round((20 - model.fast_window) / 18, 3),
            "shield_intensity": round(1.0 - model.risk_fraction, 3),
            "dominant_plugin": PLUGIN_IDS[model.plugin_weights.index(max(model.plugin_weights))],
        },
        "model": {
            "fast_window": model.fast_window,
            "slow_window": model.slow_window,
            "risk_fraction": model.risk_fraction,
            "plugin_weights": dict(zip(PLUGIN_IDS, model.plugin_weights)),
        },
        "plugins": [
            {**info, "weight_pct": model.plugin_weights[i],
             "prediction": {key: round(value, 6) for key, value in components[info["id"]].items()}}
            for i, info in enumerate(PLUGIN_INFO)
        ],
        "prediction": {key: round(value, 6) for key, value in values.items()},
        "signal": choice,
        "synthetic_prices": list(SYNTHETIC_PRICES),
        "sample_coins_exposed": round(10000 * model.risk_fraction),
        "python": source,
        "source_sha256": hashlib.sha256(source.encode()).hexdigest(),
        "notice": "架空の価格データによる機能テスト。投資判断には使用できません。",
    }

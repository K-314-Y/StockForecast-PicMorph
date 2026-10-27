"""Creatures are editable *declarative* models, never executable user plugins.

Every indicator sees supplied synthetic history only. All calculations are
deterministic and side-effect free. Real market feeds and arbitrary code are out
of scope; user-facing "plugin" means one of these allowlisted functions.
"""
from __future__ import annotations

import ast
import hashlib
import inspect
import math
from indicators import REGISTRY, IDS, registry_info, adjust_probability_strength
from dataclasses import dataclass
from typing import Any

SYNTHETIC_PRICES = (
    100, 101, 102, 101, 103, 102, 100, 99, 100, 102,
    105, 106, 104, 102, 101, 100, 99, 98, 100, 101,
    103, 104, 106, 105, 103, 101, 100, 99, 98, 97,
    96, 98, 99, 101, 103, 102, 104, 107, 106, 109,
)
EYES = {"falcon": (3, 9), "owl": (5, 12), "turtle": (8, 20)}
PLUGIN_IDS = IDS
PLUGIN_INFO = registry_info()
DEFAULT_WEIGHTS = (100,) + (0,) * (len(REGISTRY) - 1)
DEFAULT_STRENGTHS = (100,) * len(REGISTRY)


@dataclass(frozen=True)
class Model:
    fast_window: int = 3
    slow_window: int = 9
    risk_fraction: float = 0.35
    plugin_weights: tuple[int, ...] = DEFAULT_WEIGHTS
    plugin_strengths: tuple[int, ...] = DEFAULT_STRENGTHS

    def __post_init__(self) -> None:
        if type(self.fast_window) is not int or type(self.slow_window) is not int:
            raise ValueError("期間は整数で指定してください")
        if not (2 <= self.fast_window < self.slow_window <= 20):
            raise ValueError("期間は 2 <= FAST < SLOW <= 20 にしてください")
        if type(self.risk_fraction) not in (int, float) or not math.isfinite(self.risk_fraction):
            raise ValueError("リスク比率は有限の数値で指定してください")
        if not (0.05 <= self.risk_fraction <= 1.0):
            raise ValueError("リスク比率は 0.05〜1.0 にしてください")
        if not isinstance(self.plugin_weights, tuple) or len(self.plugin_weights) != len(PLUGIN_IDS) or any(
            type(w) is not int or not 0 <= w <= 100 for w in self.plugin_weights
        ) or sum(self.plugin_weights) != 100:
            raise ValueError("プラグイン重みは0〜100の整数で合計100%にしてください")
        if not isinstance(self.plugin_strengths, tuple) or len(self.plugin_strengths) != len(PLUGIN_IDS) or any(
            type(value) is not int or not 50 <= value <= 150 for value in self.plugin_strengths
        ):
            raise ValueError("各分析プラグインの感度は50〜150の整数で指定してください")


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

SPRINT4_SOURCE_TEMPLATE = '''# Declarative indicator composition. Only numeric constants are editable.
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


def sprint4_python_source(model: Model) -> str:
    """Bit-for-bit historical preview for archived Sprint-4 SHA checks."""
    return _format(SPRINT4_SOURCE_TEMPLATE, model)


def sprint5_python_source(model: Model) -> str:
    """Generate displayable working Python using audited local indicators.

    Every built-in function is checked into indicators.py. User submissions
    are parsed and compared against its AST, never executed.
    """
    header = [
        "# Creature Lab model preview. Edit numeric constants only.",
        "FAST_WINDOW = " + str(model.fast_window),
        "SLOW_WINDOW = " + str(model.slow_window),
        "RISK_FRACTION = " + format(model.risk_fraction, ".4g"),
    ]
    header += ["WEIGHT_" + spec.id.upper() + " = " + str(model.plugin_weights[i])
               for i, spec in enumerate(REGISTRY)]
    functions = [inspect.getsource(spec.evaluate).strip() for spec in REGISTRY]
    lines = ["def forecast(prices):"]
    for spec in REGISTRY:
        lines.append("    p_" + spec.id + " = " + spec.evaluate.__name__
                     + "(prices, FAST_WINDOW, SLOW_WINDOW)")
    for cls in ("UP", "FLAT"):
        terms = ["WEIGHT_" + spec.id.upper() + " * p_" + spec.id + '["' + cls + '"]'
                 for spec in REGISTRY]
        lines.append("    " + cls.lower() + " = (" + " + ".join(terms) + ") / 100")
    lines.append('    return {"UP": up, "FLAT": flat, "DOWN": max(0.0, 1.0 - up - flat)}')
    return "\n".join(header) + "\n\n\n" + "\n\n\n".join(functions) + "\n\n\n" + "\n".join(lines) + "\n"


def python_source(model: Model) -> str:
    """Full current executable-looking preview, but never execute submitted code."""
    old = sprint5_python_source(model)
    first = inspect.getsource(REGISTRY[0].evaluate).strip()
    settings = "\n".join(
        "STRENGTH_" + spec.id.upper() + " = " + str(model.plugin_strengths[i])
        for i, spec in enumerate(REGISTRY)
    )
    source = old.replace(
        "\n\n\n" + first,
        "\n" + settings + "\n\n\n" +
        inspect.getsource(adjust_probability_strength).strip() + "\n\n\n" + first, 1
    )
    for spec in REGISTRY:
        call = "    p_" + spec.id + " = " + spec.evaluate.__name__ + "(prices, FAST_WINDOW, SLOW_WINDOW)\n"
        tune = "    p_" + spec.id + " = adjust_probability_strength(p_" + spec.id + ", STRENGTH_" + spec.id.upper() + ")\n"
        if call not in source:
            raise RuntimeError("code template mismatch: " + spec.id)
        source = source.replace(call, call + tune, 1)
    return source


def legacy_python_source(model: Model) -> str:
    return _format(LEGACY_SOURCE_TEMPLATE, model)


def model_from_python(source: str) -> Model:
    """AST-only parsing: model values can change, function bodies cannot."""
    if not isinstance(source, str) or len(source) > 14000:
        raise ValueError("ソースコードのサイズが不正です")
    try:
        parsed = ast.parse(source)
    except SyntaxError as exc:
        raise ValueError("Pythonの構文を確認してください") from exc

    # Read old editor drafts without upgrading their function code unsafely.
    versions = (
        (ast.parse(python_source(Model())),
         ("FAST_WINDOW", "SLOW_WINDOW", "RISK_FRACTION") +
         tuple("WEIGHT_" + k.upper() for k in PLUGIN_IDS) +
         tuple("STRENGTH_" + k.upper() for k in PLUGIN_IDS)),
        (ast.parse(sprint5_python_source(Model())),
         ("FAST_WINDOW", "SLOW_WINDOW", "RISK_FRACTION") +
         tuple("WEIGHT_" + k.upper() for k in PLUGIN_IDS)),
        (ast.parse(sprint4_python_source(Model())),
         ("FAST_WINDOW", "SLOW_WINDOW", "RISK_FRACTION",
          "WEIGHT_TREND", "WEIGHT_MOMENTUM", "WEIGHT_VOLATILITY")),
    )
    for expected, names in versions:
        if len(parsed.body) != len(expected.body):
            continue
        values = {}
        for index, name in enumerate(names):
            node = parsed.body[index]
            if (not isinstance(node, ast.Assign) or len(node.targets) != 1
                or not isinstance(node.targets[0], ast.Name) or node.targets[0].id != name
                or not isinstance(node.value, ast.Constant)
                or type(node.value.value) not in (int, float)):
                break
            values[name] = node.value.value
        else:
            if all(
                ast.dump(parsed.body[i], include_attributes=False) ==
                ast.dump(expected.body[i], include_attributes=False)
                for i in range(len(names), len(parsed.body))
            ):
                weights = tuple(values.get("WEIGHT_" + k.upper(), 0) for k in PLUGIN_IDS)
                return Model(values["FAST_WINDOW"], values["SLOW_WINDOW"],
                             values["RISK_FRACTION"], weights,
                             tuple(values.get("STRENGTH_" + k.upper(), 100)
                                   for k in PLUGIN_IDS))
    raise ValueError("数値定数のみ編集可能です。予測関数の変更や未知のプラグインは使えません")


def with_visual_change(current: Model, *, eye: str | None = None, risk: Any = None) -> Model:
    if eye is not None and eye not in EYES:
        raise ValueError("未知の目の装備です")
    fast, slow = EYES[eye] if eye is not None else (
        current.fast_window, current.slow_window
    )
    return Model(fast, slow, current.risk_fraction if risk is None else risk,
                 current.plugin_weights, current.plugin_strengths)


def with_plugin_change(current: Model, weights: object) -> Model:
    if not isinstance(weights, dict) or set(weights) != set(PLUGIN_IDS):
        raise ValueError("登録済みプラグインの重みをすべて指定してください")
    return Model(current.fast_window, current.slow_window,
                 current.risk_fraction, tuple(weights[k] for k in PLUGIN_IDS),
                 current.plugin_strengths)


def with_plugin_strength_change(current: Model, strengths: object) -> Model:
    if not isinstance(strengths, dict) or set(strengths) != set(PLUGIN_IDS):
        raise ValueError("登録済み分析すべての感度が必要です")
    return Model(current.fast_window, current.slow_window, current.risk_fraction,
                 current.plugin_weights, tuple(strengths[k] for k in PLUGIN_IDS))


def prediction_components(model: Model, prices: tuple[int, ...] = SYNTHETIC_PRICES) -> dict[str, dict[str, float]]:
    if len(prices) < model.slow_window or not all(
        type(v) in (int, float) and math.isfinite(v) and v > 0 for v in prices
    ):
        raise ValueError("利用できる合成データが不足しています")
    result = {}
    for spec in REGISTRY:
        probs = adjust_probability_strength(
            spec.evaluate(prices, model.fast_window, model.slow_window),
            model.plugin_strengths[PLUGIN_IDS.index(spec.id)]
        )
        if set(probs) != {"UP", "FLAT", "DOWN"} or any(
            not isinstance(v, (int, float)) or not math.isfinite(v)
            or v < -1e-12 or v > 1+1e-12 for v in probs.values()
        ) or not math.isclose(sum(probs.values()), 1, abs_tol=1e-9):
            raise ValueError("分析プラグインの出力確率が不正です: " + spec.id)
        result[spec.id] = probs
    return result


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
            "plugin_strengths": dict(zip(PLUGIN_IDS, model.plugin_strengths)),
        },
        "plugins": [
            {**info, "weight_pct": model.plugin_weights[i],
             "strength_pct": model.plugin_strengths[i],
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

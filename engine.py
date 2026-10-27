"""Sprint 1: deterministic, isolated character <-> prediction prototype.

No market feeds, no real funds, no arbitrary Python execution. All prices are synthetic.
"""
from __future__ import annotations

import ast
import hashlib
import math
from dataclasses import dataclass
from typing import Any

# Invented test data, deliberately not market prices.
SYNTHETIC_PRICES = (
    100, 101, 102, 101, 103, 102, 100, 99, 100, 102,
    105, 106, 104, 102, 101, 100, 99, 98, 100, 101,
    103, 104, 106, 105, 103, 101, 100, 99, 98, 97,
    96, 98, 99, 101, 103, 102, 104, 107, 106, 109,
)
EYES = {"falcon": (3, 9), "owl": (5, 12), "turtle": (8, 20)}


@dataclass(frozen=True)
class Model:
    fast_window: int = 3
    slow_window: int = 9
    risk_fraction: float = 0.35

    def __post_init__(self) -> None:
        if type(self.fast_window) is not int or type(self.slow_window) is not int:
            raise ValueError("期間は整数で指定してください")
        if not (2 <= self.fast_window < self.slow_window <= 20):
            raise ValueError("期間は 2 <= FAST < SLOW <= 20 にしてください")
        if type(self.risk_fraction) not in (int, float) or not math.isfinite(self.risk_fraction):
            raise ValueError("リスク比率は有限の数値で指定してください")
        if not (0.05 <= self.risk_fraction <= 1.0):
            raise ValueError("リスク比率は 0.05〜1.0 にしてください")


SOURCE_TEMPLATE = '''# Sprint 1: constants can be edited. Arbitrary Python is NOT executed.
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


def python_source(model: Model) -> str:
    return SOURCE_TEMPLATE.format(
        fast=model.fast_window,
        slow=model.slow_window,
        risk=format(model.risk_fraction, ".4g"),
    )


def model_from_python(source: str) -> Model:
    """Parse only the three numeric constants. Reject all code changes.

    The supplied Python is *never* compiled, evaluated or executed.
    """
    if not isinstance(source, str) or len(source) > 5000:
        raise ValueError("ソースコードのサイズが不正です")
    try:
        parsed = ast.parse(source)
    except SyntaxError as exc:
        raise ValueError("Pythonの構文を確認してください") from exc
    expected = ast.parse(python_source(Model()))
    if len(parsed.body) != len(expected.body):
        raise ValueError("試作版では定数の編集のみ対応しています")
    assignments: dict[str, int | float] = {}
    names = ("FAST_WINDOW", "SLOW_WINDOW", "RISK_FRACTION")
    for index, name in enumerate(names):
        node = parsed.body[index]
        if (
            not isinstance(node, ast.Assign)
            or len(node.targets) != 1
            or not isinstance(node.targets[0], ast.Name)
            or node.targets[0].id != name
            or not isinstance(node.value, ast.Constant)
            or type(node.value.value) not in (int, float)
        ):
            raise ValueError("定数の名前と数値だけ変更できます")
        assignments[name] = node.value.value
    for index in range(3, len(parsed.body)):
        if ast.dump(parsed.body[index], include_attributes=False) != ast.dump(
            expected.body[index], include_attributes=False
        ):
            raise ValueError("試作版では予測関数本体の変更には未対応です")
    return Model(
        fast_window=assignments["FAST_WINDOW"],
        slow_window=assignments["SLOW_WINDOW"],
        risk_fraction=assignments["RISK_FRACTION"],
    )


def with_visual_change(current: Model, *, eye: str | None = None, risk: Any = None) -> Model:
    if eye is not None and eye not in EYES:
        raise ValueError("未知の目の装備です")
    fast, slow = EYES[eye] if eye is not None else (
        current.fast_window, current.slow_window
    )
    return Model(fast, slow, current.risk_fraction if risk is None else risk)


def prediction(model: Model, prices: tuple[int, ...] = SYNTHETIC_PRICES) -> dict[str, float]:
    if len(prices) < model.slow_window or not all(
        type(v) in (int, float) and math.isfinite(v) and v > 0 for v in prices
    ):
        raise ValueError("利用できる合成データが不足しています")
    fast = sum(prices[-model.fast_window:]) / model.fast_window
    slow = sum(prices[-model.slow_window:]) / model.slow_window
    momentum = fast / slow - 1.0
    strength = max(-1.0, min(1.0, momentum / 0.06))
    flat = 0.20 + 0.20 * (1.0 - abs(strength))
    up = (1.0 - flat) * (strength + 1.0) / 2.0
    down = 1.0 - flat - up
    result = {"UP": up, "FLAT": flat, "DOWN": down}
    if not math.isclose(sum(result.values()), 1.0, abs_tol=1e-12):
        raise RuntimeError("確率が正規化されていません")
    return result


def multiclass_brier(actual: str, probabilities: dict[str, float]) -> float:
    """The same three-class Brier definition used in V6's offline_metrics."""
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
    choice = max(("UP", "FLAT", "DOWN"), key=values.get)
    source = python_source(model)
    return {
        "revision": revision,
        "visual": {
            "eye": eye,
            "eye_intensity": round((20 - model.fast_window) / 18, 3),
            "shield_intensity": round(1.0 - model.risk_fraction, 3),
        },
        "model": {
            "fast_window": model.fast_window,
            "slow_window": model.slow_window,
            "risk_fraction": model.risk_fraction,
        },
        "prediction": {key: round(value, 6) for key, value in values.items()},
        "signal": choice,
        "synthetic_prices": list(SYNTHETIC_PRICES),
        "sample_coins_exposed": round(10000 * model.risk_fraction),
        "python": source,
        "source_sha256": hashlib.sha256(source.encode()).hexdigest(),
        "notice": "架空の価格データによる機能テスト。投資判断には使用できません。",
    }

"""Audited, local indicator catalog. These are built-ins, NOT arbitrary uploads.

Adding an indicator means implementing a callable with signature
(prices, fast_window, slow_window) and registering one IndicatorSpec.
Only code shipped with the project is trusted to generate Python previews.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable


def trend_indicator(prices, fast_window, slow_window):
    fast = sum(prices[-fast_window:]) / fast_window
    slow = sum(prices[-slow_window:]) / slow_window
    delta = fast / slow - 1.0
    strength = max(-1.0, min(1.0, delta / 0.06))
    flat = 0.20 + 0.20 * (1.0 - abs(strength))
    up = (1.0 - flat) * (strength + 1.0) / 2.0
    return {"UP": up, "FLAT": flat, "DOWN": max(0.0, 1.0 - up - flat)}


def momentum_indicator(prices, fast_window, slow_window):
    roc = prices[-1] / prices[-fast_window - 1] - 1.0
    strength = max(-1.0, min(1.0, roc / 0.08))
    flat = 0.15 + 0.25 * (1.0 - abs(strength))
    up = (1.0 - flat) * (strength + 1.0) / 2.0
    return {"UP": up, "FLAT": flat, "DOWN": max(0.0, 1.0 - up - flat)}


def volatility_indicator(prices, fast_window, slow_window):
    recent = prices[-slow_window:]
    vol = sum(abs(recent[i] / recent[i-1] - 1.0)
              for i in range(1, len(recent))) / (len(recent) - 1)
    flat = max(0.15, min(0.60, 0.60 - 10.0 * vol))
    up = (1.0 - flat) / 2.0
    return {"UP": up, "FLAT": flat, "DOWN": max(0.0, 1.0 - up - flat)}


def reversion_indicator(prices, fast_window, slow_window):
    """A simple synthetic mean-reversion signal, not trained or proven."""
    mean = sum(prices[-slow_window:]) / slow_window
    deviation = prices[-1] / mean - 1.0
    strength = max(-1.0, min(1.0, deviation / 0.06))
    flat = 0.25 + 0.20 * (1.0 - abs(strength))
    up = (1.0 - flat) * (1.0 - strength) / 2.0
    return {"UP": up, "FLAT": flat, "DOWN": max(0.0, 1.0 - up - flat)}


@dataclass(frozen=True)
class IndicatorSpec:
    id: str
    name: str
    description: str
    accessory: str
    icon: str
    evaluate: Callable

    def public_info(self) -> dict:
        return {
            "id": self.id, "name": self.name, "description": self.description,
            "accessory": self.accessory, "icon": self.icon,
        }


REGISTRY = (
    IndicatorSpec("trend", "トレンド", "2本の移動平均で方向を判定", "lens", "📡", trend_indicator),
    IndicatorSpec("momentum", "モメンタム", "直近の価格変化で方向を判定", "spark", "⚡", momentum_indicator),
    IndicatorSpec("volatility", "ボラティリティ", "値動きの幅から横ばいを推定", "halo", "🌫️", volatility_indicator),
    IndicatorSpec("reversion", "平均回帰", "価格の平均への戻りを仮定", "spiral", "🌀", reversion_indicator),
)
IDS = tuple(ind.id for ind in REGISTRY)
if len(IDS) != len(set(IDS)) or any(not k.isascii() or not k.isidentifier() for k in IDS):
    raise RuntimeError("プラグインIDが重複または不正です")


def registry_info() -> tuple[dict, ...]:
    return tuple(spec.public_info() for spec in REGISTRY)

"""Game-only indicators selected by equipped ZIP character accessories."""
from __future__ import annotations

import math

RULE_VERSION = "accessory-analysis-v1"
COMBINATION_VERSION = "accessory-analysis-v2"
METHODS = {
    "star": "bollinger_breakout",
    "glasses": "rsi_oversold",
    "ribbon": "macd_momentum",
    "none": "moving_average_trend",
}


def _average(values: tuple[float, ...] | list[float]) -> float:
    return sum(values) / len(values)


def _ema(prices: tuple[float, ...], period: int) -> list[float]:
    factor = 2 / (period + 1)
    result = [prices[0]]
    for price in prices[1:]:
        result.append(factor * price + (1 - factor) * result[-1])
    return result


def _rsi(prices: tuple[float, ...], period: int = 7) -> float:
    changes = [prices[i] - prices[i - 1] for i in range(len(prices) - period, len(prices))]
    gain = sum(max(0.0, move) for move in changes) / period
    loss = sum(max(0.0, -move) for move in changes) / period
    if loss == 0:
        return 100.0 if gain else 50.0
    return 100.0 - 100.0 / (1.0 + gain / loss)


def normalize_methods(methods: list[str]) -> tuple[str, ...]:
    if (type(methods) is not list or not 1 <= len(methods) <= 3
            or any(type(method) is not str or method not in METHODS.values() for method in methods)
            or len(set(methods)) != len(methods)):
        raise ValueError("invalid_accessory_methods")
    return tuple(sorted(methods))


def _combined_signal(methods: tuple[str, ...], history: tuple[float, ...], baseline_up: float) -> str:
    if not isinstance(history, tuple) or not 20 <= len(history) <= 1000:
        raise ValueError("insufficient_accessory_history")
    if any(type(p) not in (int, float) or not math.isfinite(p) or p <= 0 for p in history):
        raise ValueError("invalid_accessory_history")
    if type(baseline_up) not in (int, float) or not math.isfinite(baseline_up) or not 0 <= baseline_up <= 1:
        raise ValueError("invalid_baseline_probability")
    primary_support = _average([_indicator_support(method, history) for method in methods])
    combined_support = .8 * primary_support + .2 * baseline_up
    return "LONG" if combined_support > .54 else "CASH"


def _indicator_support(method: str, history: tuple[float, ...]) -> float:
    latest = history[-1]
    if method == "bollinger_breakout":
        # Bollinger upper-band breakthrough: compare today's close to the
        # 12 previous closes, never to tomorrow's price.
        window = history[-13:-1]
        mean = _average(window)
        deviation = math.sqrt(_average([(p - mean) ** 2 for p in window]))
        gap = (latest - (mean + 1.2 * deviation)) / max(0.25 * deviation, latest * .005)
    elif method == "rsi_oversold":
        # RSI(7) oscillator: look for oversold prices and potential recovery.
        gap = (35 - _rsi(history)) / 12
    elif method == "macd_momentum":
        # MACD(5,12) minus its EMA(4) signal: measure momentum acceleration.
        fast = _ema(history, 5)
        slow = _ema(history, 12)
        difference = tuple(f - s for f, s in zip(fast, slow))
        signal_line = _ema(difference, 4)
        histogram = [v - ref for v, ref in zip(difference, signal_line)]
        gap = histogram[-1] / max(latest * .004, 1e-9)
    elif method == "moving_average_trend":
        # Simple short/long moving-average trend following.
        gap = (_average(history[-5:]) - _average(history[-12:])) / max(latest * .008, 1e-9)
    else:
        raise ValueError("unsupported_accessory_analysis")
    return .5 + .45 * math.tanh(gap)


def accessory_signal(accessory: str, history: tuple[float, ...], baseline_up: float = 0.5) -> str:
    """Run the original single-accessory rule before revealing the next close."""
    if type(accessory) is not str or accessory not in METHODS:
        raise ValueError("unsupported_accessory_analysis")
    return _combined_signal((METHODS[accessory],), history, baseline_up)


def equipped_accessory_signal(methods: list[str], history: tuple[float, ...], baseline_up: float = 0.5) -> str:
    """Give each equipped method equal weight in the primary analysis."""
    return _combined_signal(normalize_methods(methods), history, baseline_up)

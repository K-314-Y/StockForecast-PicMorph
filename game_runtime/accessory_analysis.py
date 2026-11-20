"""Game-only, allowlisted indicator families selected by ZIP character accessories.

The accessory selects the PRIMARY indicator; the saved appearance model's
plugin weights are a small SECONDARY confirmation, so changing hair/colour
still has a computational effect. All data is historical at decision time.
No external quotes, training, arbitrary code, broker calls, or V9 writes.
"""
from __future__ import annotations

import math

RULE_VERSION = "accessory-analysis-v1"
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


def accessory_signal(accessory: str, history: tuple[float, ...], baseline_up: float = 0.5) -> str:
    """Decide LONG/CASH before the *next* close using past prices only.

    baseline_up is the existing weighted-model probability, for light secondary
    confirmation. The accessory indicator family drives the majority of the rule.
    """
    if type(accessory) is not str or accessory not in METHODS:
        raise ValueError("unsupported_accessory_analysis")
    if not isinstance(history, tuple) or not 20 <= len(history) <= 1000:
        raise ValueError("insufficient_accessory_history")
    if any(type(p) not in (int, float) or not math.isfinite(p) or p <= 0 for p in history):
        raise ValueError("invalid_accessory_history")
    if type(baseline_up) not in (int, float) or not math.isfinite(baseline_up) or not 0 <= baseline_up <= 1:
        raise ValueError("invalid_baseline_probability")

    latest = history[-1]
    if accessory == "star":
        # Bollinger upper-band breakthrough: compare today's close to the
        # 12 previous closes, never to tomorrow's price.
        window = history[-13:-1]
        mean = _average(window)
        deviation = math.sqrt(_average([(p - mean) ** 2 for p in window]))
        gap = (latest - (mean + 1.2 * deviation)) / max(0.25 * deviation, latest * .005)
    elif accessory == "glasses":
        # RSI(7) oscillator: look for oversold prices and potential recovery.
        gap = (35 - _rsi(history)) / 12
    elif accessory == "ribbon":
        # MACD(5,12) minus its EMA(4) signal: measure momentum acceleration.
        fast = _ema(history, 5)
        slow = _ema(history, 12)
        difference = tuple(f - s for f, s in zip(fast, slow))
        signal_line = _ema(difference, 4)
        histogram = [v - ref for v, ref in zip(difference, signal_line)]
        gap = histogram[-1] / max(latest * .004, 1e-9)
    else:
        # No accessory: simple short/long moving-average trend following.
        gap = (_average(history[-5:]) - _average(history[-12:])) / max(latest * .008, 1e-9)
    primary_support = .5 + .45 * math.tanh(gap)
    combined_support = .8 * primary_support + .2 * baseline_up
    return "LONG" if combined_support > .54 else "CASH"

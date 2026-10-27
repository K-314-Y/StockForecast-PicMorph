"""Sprint 3: deterministic paper-money simulation and safe model snapshots.

Practice only: invented prices, no real orders, no market or network access.
All strategies see historical data strictly through their decision timestamp.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from engine import EYES, Model, SYNTHETIC_PRICES, prediction, python_source

ROOT = Path(__file__).resolve().parent
SAVE_FILE = ROOT / "local_state" / "versions.json"
INITIAL_COINS = 10_000
FEE_RATE = 0.001  # example-only 0.1% fee, not any exchange quotation
# Previously invented price candles, hidden from the strategy until each step.
PRACTICE_PATH = (107, 106, 104, 101, 100, 104, 108, 112, 110, 114, 113, 117)
PRESETS = {
    "owl": Model(*EYES["owl"], 0.50),
    "turtle": Model(*EYES["turtle"], 0.25),
}
SLOTS = ("mine", "owl", "turtle")


def parse_allocations(data: object) -> dict[str, int]:
    if not isinstance(data, dict) or set(data) != set(SLOTS):
        raise ValueError("3つのキャラの配分をすべて指定してください")
    if any(type(data[k]) is not int or data[k] < 0 or data[k] > 100 for k in SLOTS):
        raise ValueError("配分は0〜100の整数％で指定してください")
    if sum(data.values()) > 100:
        raise ValueError("配分の合計は100%以下にしてください")
    return {k: data[k] for k in SLOTS}


def run_practice(current: Model, proposed: object) -> dict:
    """Each individual pocket is long/cash-only. Never executes submitted code."""
    allocations = parse_allocations(proposed)
    models = {"mine": current, **PRESETS}
    pockets = {
        k: {"cash": INITIAL_COINS * allocations[k] / 100.0,
            "units": 0.0, "fees": 0.0, "trades": 0,
            "initial": INITIAL_COINS * allocations[k] / 100.0,
            "long_steps": 0}
        for k in SLOTS
    }
    idle = INITIAL_COINS * (100 - sum(allocations.values())) / 100.0
    initial_price = SYNTHETIC_PRICES[-1]
    visible = list(SYNTHETIC_PRICES)
    equity_path = [float(INITIAL_COINS)]
    trades = []

    for step, new_price in enumerate(PRACTICE_PATH, 1):
        # The strategy knows only past prices. It trades at the last known price,
        # then observes the next synthetic candle.
        trade_price = visible[-1]
        step_signals = {}
        for key in SLOTS:
            pocket, model = pockets[key], models[key]
            probs = prediction(model, tuple(visible))
            long_now = probs["UP"] > 0.52 and probs["UP"] > probs["DOWN"] + 0.05
            step_signals[key] = "LONG" if long_now else "CASH"
            if long_now:
                pocket["long_steps"] += 1
            total_now = pocket["cash"] + pocket["units"] * trade_price
            target = total_now * model.risk_fraction if long_now else 0.0
            held_value = pocket["units"] * trade_price
            if target > held_value + 1e-8:
                gross = min(target - held_value, pocket["cash"] / (1 + FEE_RATE))
                if gross > 1e-8:
                    fee = gross * FEE_RATE
                    pocket["cash"] -= gross + fee
                    pocket["units"] += gross / trade_price
                    pocket["fees"] += fee
                    pocket["trades"] += 1
            elif held_value > target + 1e-8:
                gross = held_value - target
                fee = gross * FEE_RATE
                pocket["units"] -= gross / trade_price
                pocket["cash"] += gross - fee
                pocket["fees"] += fee
                pocket["trades"] += 1
            if pocket["cash"] < -1e-7 or pocket["units"] < -1e-7:
                raise RuntimeError("資金がマイナスになりました")
        visible.append(new_price)
        equity = idle + sum(
            p["cash"] + p["units"] * new_price for p in pockets.values()
        )
        equity_path.append(equity)
        trades.append({"step": step, "price": new_price, "signals": step_signals})

    final = equity_path[-1]
    peak = equity_path[0]
    max_dd = 0.0
    for value in equity_path[1:]:
        peak = max(peak, value)
        max_dd = max(max_dd, 1 - value / peak)
    benchmark_final = INITIAL_COINS * PRACTICE_PATH[-1] / initial_price
    result = {
        "mode": "PRACTICE_SYNTHETIC_ONLY",
        "initial_coins": INITIAL_COINS,
        "final_coins": round(final, 2),
        "profit_coins": round(final - INITIAL_COINS, 2),
        "return_pct": round((final / INITIAL_COINS - 1) * 100, 3),
        "max_drawdown_pct": round(max_dd * 100, 3),
        "benchmark_buy_hold_pct": round((benchmark_final / INITIAL_COINS - 1) * 100, 3),
        "allocations": allocations,
        "cash_unallocated": round(idle, 2),
        "steps": len(PRACTICE_PATH),
        "fee_rate_pct": FEE_RATE * 100,
        "equity_path": [round(v, 2) for v in equity_path],
        "benchmark_path": [
            round(INITIAL_COINS * p / initial_price, 2)
            for p in (initial_price,) + PRACTICE_PATH
        ],
        "decisions": trades,
        "characters": {
            k: {
                "allocation_pct": allocations[k],
                "initial": round(p["initial"], 2),
                "final": round(p["cash"] + p["units"] * PRACTICE_PATH[-1], 2),
                "fees": round(p["fees"], 3),
                "trades": p["trades"],
                "long_steps": p["long_steps"],
                "risk_fraction": models[k].risk_fraction,
            }
            for k, p in pockets.items()
        },
        "model_sha256": hashlib.sha256(python_source(current).encode()).hexdigest(),
        "warnings": [
            "すべて架空の価格と無料のゲーム内コインです。実際の投資ではありません。",
            "同じ架空資産を3キャラが運用します。銘柄分散ではありません。",
            "過去に固定した練習シナリオで、隠れた未来データを使った実力評価ではありません。",
        ]
    }
    return result


def read_versions() -> list[dict]:
    if not SAVE_FILE.exists():
        return []
    with SAVE_FILE.open(encoding="utf-8") as f:
        payload = json.load(f)
    if not isinstance(payload, dict) or payload.get("schema") != 1:
        raise ValueError("保存データ形式が不正です")
    versions = payload.get("versions")
    if not isinstance(versions, list) or len(versions) > 100:
        raise ValueError("保存データの件数が不正です")
    return versions


def save_version(name: object, model: Model) -> dict:
    if not isinstance(name, str) or not (1 <= len(name.strip()) <= 40):
        raise ValueError("名前は1〜40文字で指定してください")
    if any(ord(ch) < 32 for ch in name) or "/" in name or "\\" in name:
        raise ValueError("使えない文字が含まれています")
    versions = read_versions()
    if len(versions) >= 100:
        raise ValueError("保存できるバージョンは100件までです")
    entry = {
        "id": uuid.uuid4().hex,
        "name": name.strip(),
        "saved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": {
            "fast_window": model.fast_window,
            "slow_window": model.slow_window,
            "risk_fraction": model.risk_fraction,
        },
        "sha256": hashlib.sha256(python_source(model).encode()).hexdigest(),
    }
    new_versions = versions + [entry]
    SAVE_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=".versions-", dir=SAVE_FILE.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"schema": 1, "versions": new_versions}, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, SAVE_FILE)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
    return entry


def load_version(version_id: object) -> Model:
    if not isinstance(version_id, str) or len(version_id) != 32 or any(
        ch not in "0123456789abcdef" for ch in version_id
    ):
        raise ValueError("バージョンIDが不正です")
    entry = next((v for v in read_versions() if v.get("id") == version_id), None)
    if not entry:
        raise ValueError("指定されたバージョンはありません")
    m = entry["model"]
    result = Model(**m)
    digest = hashlib.sha256(python_source(result).encode()).hexdigest()
    if digest != entry["sha256"]:
        raise ValueError("保存データの改ざんまたは破損を検知しました")
    return result

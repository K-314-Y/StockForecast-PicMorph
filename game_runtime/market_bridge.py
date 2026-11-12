"""Read-only historical replay bridge. Never changes V7, XP or any user model.

Data source: local SoftHompo-reformatted JPX 2024 daily reports, or optional
J-Quants API V2 adjusted daily bars when CREATURE_JQUANTS_API_KEY is configured.
Only local Node game may call this process. The API cache stays in Creature Lab.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import re
import secrets
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from predict_bridge import model_from_record, SLOTS
from engine import PLUGIN_IDS, prediction, multiclass_brier, python_source

ROOT = Path(__file__).resolve().parents[1]
LOCAL_DEFAULT = ROOT.parent / "13_株価予測" / "local_results" / "v5_workspace" / "market_inputs" / "v6_jpx_2024_actual_prehistory_20261102" / "prehistory.json"
CODES = ("40050", "46890", "47550", "50200", "72010",
         "84100", "85930", "86040", "94320", "95010")
LOOKBACK, HORIZON = 24, 12
ID_RE = re.compile(r"^mkt_[a-f0-9]{24}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def checked_rows(raw, *, adjusted, expected_code):
    """Reject duplicates/invalid rows, preserve chronological order and source flags."""
    if not isinstance(raw, list) or len(raw) > 1800:
        raise ValueError("invalid_market_rows")
    result, seen = [], set()
    for record in raw:
        if not isinstance(record, dict):
            raise ValueError("invalid_market_record")
        code, when = record.get("Code"), record.get("Date")
        if code != expected_code or not isinstance(when, str) or not DATE_RE.fullmatch(when):
            raise ValueError("invalid_market_identity")
        try:
            date.fromisoformat(when)
        except ValueError:
            raise ValueError("invalid_market_date") from None
        if when in seen:
            raise ValueError("duplicate_market_date")
        seen.add(when)
        close = record.get("AdjC" if adjusted else "C")
        if close is None:
            continue  # Halted/not traded days are never filled forward.
        if isinstance(close, bool) or not isinstance(close, (int, float)) or (
                not math.isfinite(close) or close <= 0):
            raise ValueError("invalid_market_close")
        flagged = bool(record.get("source_flags")) if not adjusted else (
            record.get("AdjFactor") not in (None, 1, 1.0))
        result.append((when, float(close), flagged))
    result.sort(key=lambda row: row[0])
    return result


def load_local():
    """Read the immutable V7 market file, never alter it."""
    path = Path(os.environ.get("CREATURE_MARKET_HISTORY_PATH", str(LOCAL_DEFAULT)))
    if not path.is_file() or path.stat().st_size > 3_000_000:
        raise ValueError("historical_source_unavailable")
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("source") != "SoftHompo JPX daily reports CSV":
        raise ValueError("historical_provenance_unverified")
    series = data.get("series")
    if not isinstance(series, dict):
        raise ValueError("historical_structure_invalid")
    out = {code: checked_rows(series[code], adjusted=False, expected_code=code)
           for code in CODES if code in series}
    return {
        "origin": "LOCAL_JPX_REPORT_CACHE_2024", "source": "SoftHompo-reformatted JPX daily reports (2024)",
        "adjusted": False,
        "warning": "2024年の再整形されたJPX日次報告の終値(C)。分割調整は未確認。配当・急変日のある期間を除外した参考用で、公式APIの取得結果ではありません。",
        "series": out,
    }


def fetch_jquants():
    """Optional one-code API V2 read, reused from a one-day local cache."""
    key = os.environ.get("CREATURE_JQUANTS_API_KEY", "").strip()
    if not key:
        raise ValueError("jquants_key_not_configured")
    cache = ROOT / "local_state" / "jquants_daily_v2_creature_cache.json"
    today = date.today()
    if cache.is_file() and cache.stat().st_size <= 3_000_000:
        try:
            previous = json.loads(cache.read_text(encoding="utf-8"))
            if previous.get("format") == 1 and previous.get("fetched_on") == today.isoformat():
                code = previous["code"]
                if code in CODES:
                    return {
                        "origin": "JQUANTS_API_V2_CACHE",
                        "source": "J-Quants API V2 equities/bars/daily",
                        "adjusted": True,
                        "warning": "過去株価の調整済み終値（AdjC）。実運用成績ではありません。再配布不可のためローカル専用です。",
                        "series": {code: checked_rows(previous["rows"], adjusted=True, expected_code=code)},
                    }
        except (KeyError, ValueError, TypeError, json.JSONDecodeError):
            pass
    # Free tier: at least 12 weeks delayed, within its historical access range.
    to = today - timedelta(days=91)
    from_day = to - timedelta(days=500)
    code = CODES[secrets.randbelow(len(CODES))]
    params = urlencode({"code": code, "from": from_day.isoformat(), "to": to.isoformat()})
    endpoint = "https://api.jquants.com/v2/equities/bars/daily?" + params
    rows, token, seen = [], None, set()
    for _ in range(3):  # Bounded pagination, no retries on 429.
        url = endpoint + ("&" + urlencode({"pagination_key": token}) if token else "")
        request = Request(url, headers={"x-api-key": key, "Accept": "application/json"})
        try:
            with urlopen(request, timeout=8) as response:
                raw = response.read(3_000_001)
            if len(raw) > 3_000_000:
                raise ValueError("jquants_response_too_large")
            data = json.loads(raw)
        except (HTTPError, URLError, TimeoutError) as error:
            raise ValueError("jquants_unavailable_or_rate_limited") from None
        if not isinstance(data, dict) or not isinstance(data.get("data"), list):
            raise ValueError("jquants_schema_invalid")
        rows.extend(data["data"])
        token = data.get("pagination_key")
        if not token:
            break
        if not isinstance(token, str) or len(token) > 512 or token in seen:
            raise ValueError("jquants_pagination_invalid")
        seen.add(token)
    else:
        raise ValueError("jquants_pagination_limit")
    cleaned = checked_rows(rows, adjusted=True, expected_code=code)
    if len(cleaned) < LOOKBACK + HORIZON:
        raise ValueError("jquants_history_insufficient")
    # Cache source rows locally, once per day. Never store API keys or mutate V7.
    cache.parent.mkdir(parents=True, exist_ok=True)
    temporary = cache.with_suffix(".tmp")
    temporary.write_text(json.dumps({"format": 1, "code": code, "rows": rows,
                                     "fetched_on": today.isoformat()},
                                    ensure_ascii=False), encoding="utf-8")
    temporary.replace(cache)
    return {
        "origin": "JQUANTS_API_V2_CACHE",
        "source": "J-Quants API V2 equities/bars/daily",
        "adjusted": True,
        "warning": "調整済み終値(AdjC)を使用。無料プランでは直近12週間が対象外。データ再配布不可、ローカル専用。",
        "series": {code: cleaned},
    }


def candidate_windows(source):
    windows = []
    for code, values in source["series"].items():
        for start in range(0, len(values) - LOOKBACK - HORIZON + 1):
            selected = values[start:start + LOOKBACK + HORIZON]
            if any(v[2] for v in selected):
                continue
            if any((date.fromisoformat(b[0]) - date.fromisoformat(a[0])).days > 10
                   for a, b in zip(selected, selected[1:])):
                continue
            # Exclude extreme unadjusted jumps, which may be corporate actions.
            if not source["adjusted"] and any(abs(b[1]/a[1]-1) > .15
                                              for a, b in zip(selected, selected[1:])):
                continue
            encoded = json.dumps([source["origin"], code,
                                  [(d, round(p, 5)) for d, p, _ in selected]],
                                 ensure_ascii=False, separators=(",", ":"))
            ident = "mkt_" + sha256(encoded.encode()).hexdigest()[:24]
            windows.append((ident, code, selected))
    if not windows:
        raise ValueError("no_eligible_historical_windows")
    return windows


def sample_window(windows, request):
    replay = request.get("replay_id")
    exclude = request.get("exclude_id")
    for value in (replay, exclude):
        if value is not None and (not isinstance(value, str) or not ID_RE.fullmatch(value)):
            raise ValueError("invalid_market_replay_id")
    if replay and exclude:
        raise ValueError("conflicting_replay_options")
    if replay:
        found = next((x for x in windows if x[0] == replay), None)
        if found is None:
            raise ValueError("replay_not_found")
        return found
    choices = [x for x in windows if x[0] != exclude] or windows
    return choices[secrets.randbelow(len(choices))]


def generate(data):
    if not isinstance(data, dict) or set(data) != {"base_model", "models", "selection"}:
        raise ValueError("invalid_market_request")
    if not isinstance(data["selection"], dict) or not set(data["selection"]) <= {
        "replay_id", "exclude_id"}:
        raise ValueError("invalid_selection")
    if not isinstance(data["models"], dict) or set(data["models"]) != set(SLOTS):
        raise ValueError("invalid_model_slots")
    models = {slot: model_from_record(data["models"][slot]) for slot in SLOTS}
    base = model_from_record(data["base_model"])
    source = fetch_jquants() if os.environ.get("CREATURE_JQUANTS_API_KEY") else load_local()
    windows = candidate_windows(source)
    wid, code, selected = sample_window(windows, data["selection"])
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
        "future_days": HORIZON, "eligible_windows": len(windows),
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


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError("request_too_large")
        response = generate(json.loads(raw))
        sys.stdout.write(json.dumps(response, ensure_ascii=False, allow_nan=False))
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print("historical replay unavailable:", str(error), file=sys.stderr)
        sys.exit(1)

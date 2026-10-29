"""Private, in-memory J-Quants V2 replay. No orders, caching or raw-data export.

Only unadjusted C is used. Calendar validation prevents silent missing-session
compression, and any AdjFactor != 1 in the 40 + 12 sessions rejects the run.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
from datetime import date, datetime, timedelta, timezone
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from challenge import compare_prices

BASE_URL = "https://api.jquants.com/v2"
BARS_PATH = "/equities/bars/daily"
CALENDAR_PATH = "/markets/calendar"
PROVIDER = "J-Quants API V2 / JPX総研"
WARMUP = 40
STEPS = 12
MAX_BYTES = 2_000_000
MAX_PAGES = 10
JST = timezone(timedelta(hours=9))
SETUP_MESSAGE = ("実相場リプレイの設定が未完了です。起動する端末で環境変数 "
                 "JQUANTS_API_KEY を設定し、アプリを再起動してください。"
                 "キーは画面やチャットに入力しないでください。")
WARNING = ("過去の実相場を使ったヒストリカル結果で、今後の予測能力や利益を保証しません。"
           "仮想コインのみ・実際の発注なし・XP付与なし。個人のローカル利用限定です。")


class MarketError(Exception):
    """Only locally authored messages may cross the HTTP boundary."""
    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code = code
        self.status = status


def today_jst() -> date:
    return datetime.now(JST).date()


def _configured() -> bool:
    key = os.environ.get("JQUANTS_API_KEY", "")
    return bool(key) and all(33 <= ord(c) <= 126 for c in key)


def market_status() -> dict:
    configured = _configured()
    return {
        "configured": configured,
        "status": "configured_unverified" if configured else "not_configured",
        "message": "キー設定あり（接続・権限は未確認）。" if configured else SETUP_MESSAGE,
        "provider": PROVIDER, "local_only": True,
        "warmup_sessions": WARMUP, "steps": STEPS,
        "max_end_date": (today_jst() - timedelta(days=1)).isoformat(),
        "price_field": "C", "warning": WARNING,
    }


def _parse_date(value: object) -> date:
    if type(value) is not str or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise ValueError("invalid date")
    return date.fromisoformat(value)


def validate_request(payload: object) -> tuple[str, date]:
    if type(payload) is not dict or set(payload) != {"code", "end_date"}:
        raise MarketError("invalid_request", "code と end_date だけを指定してください。URLは指定できません。", 400)
    code = payload["code"]
    if type(code) is not str or not re.fullmatch(r"[0-9]{4,5}", code):
        raise MarketError("invalid_code", "銘柄コードは半角数字4桁または5桁の文字列で指定してください。", 400)
    try:
        end = _parse_date(payload["end_date"])
        if end >= today_jst():
            raise ValueError("not past")
    except ValueError:
        raise MarketError("invalid_end_date", "終了日は日本時間の昨日以前の実在する日付（YYYY-MM-DD）で指定してください。", 400) from None
    return code, end


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class JQuantsClient:
    def __init__(self):
        if not _configured():
            raise MarketError("not_configured", SETUP_MESSAGE, 503)
        self._key = os.environ["JQUANTS_API_KEY"]
        # No redirects or environment-provided proxies may forward the key.
        self._opener = build_opener(ProxyHandler({}), _NoRedirect())

    def _page(self, path: str, params: dict) -> dict:
        if path not in (BARS_PATH, CALENDAR_PATH):
            raise MarketError("invalid_endpoint", "取得先が不正です。", 400)
        req = Request(BASE_URL + path + "?" + urlencode(params),
                      headers={"x-api-key": self._key, "Accept": "application/json"})
        try:
            with self._opener.open(req, timeout=15) as response:
                if response.status != 200:
                    raise MarketError("upstream_http", "J-Quantsが正常な応答を返しませんでした。", 502)
                raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise MarketError("response_too_large", "J-Quantsの応答サイズが上限を超えました。", 502)
            result = json.loads(raw)
            if type(result) is not dict or type(result.get("data")) is not list:
                raise ValueError("invalid V2 data")
            return result
        except HTTPError as exc:
            # Never return upstream response bodies, headers, URLs or exceptions.
            code = exc.code
            exc.close()
            messages = {
                401: "J-Quants認証エラー（HTTP 401）。端末のAPIキーを確認してください。",
                403: "J-Quants権限エラー（HTTP 403）。契約と取得可能期間を確認してください。",
                429: "J-Quantsの取得回数制限（HTTP 429）。しばらく待ってから実行してください。",
            }
            raise MarketError(f"upstream_{code}", messages.get(code, "J-QuantsのHTTPエラーで取得を中止しました。"),
                              429 if code == 429 else 502) from None
        except (URLError, OSError, HTTPException):
            raise MarketError("network_error", "J-Quantsに接続できませんでした。通信環境を確認してください。", 502) from None
        except (ValueError, UnicodeError, RecursionError):
            raise MarketError("invalid_response", "J-Quants V2の応答形式が不正です。", 502) from None

    def rows(self, path: str, params: dict) -> list[dict]:
        result, seen = [], set()
        query = dict(params)
        for _ in range(MAX_PAGES):
            page = self._page(path, query)
            result.extend(page["data"])
            if len(result) > 5000:
                raise MarketError("too_many_rows", "取得件数が上限を超えました。", 502)
            key = page.get("pagination_key")
            if key is None or key == "":
                return result
            if type(key) is not str or len(key) > 4096 or key in seen:
                raise MarketError("invalid_pagination", "J-Quantsのページ情報が不正または重複しています。", 502)
            seen.add(key)
            query["pagination_key"] = key
        raise MarketError("pagination_limit", "取得ページ上限に達したため中止しました。", 502)


def _sessions(rows: list[dict], start: date, end: date) -> list[str]:
    calendar = {}
    for row in rows:
        try:
            day = _parse_date(row["Date"])
            division = row["HolDiv"]
            if type(division) is not str or division not in ("0", "1", "2", "3"):
                raise ValueError("division")
            if not start <= day <= end or day in calendar:
                raise ValueError("date")
            calendar[day] = division
        except (KeyError, TypeError, ValueError):
            raise MarketError("invalid_calendar", "取引カレンダーに不正・重複データがあります。") from None
    # Require every calendar day, including closures, so missing rows cannot
    # silently turn a trading day into an assumed holiday.
    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    if set(calendar) != set(days):
        raise MarketError("incomplete_calendar", "取引カレンダーが欠損しています。契約の取得可能期間も確認してください。")
    sessions = [d.isoformat() for d in days if calendar[d] in ("1", "2")]
    if len(sessions) < WARMUP + STEPS:
        raise MarketError("insufficient_history", "40営業日の準備期間と12営業日の対戦期間が必要です。")
    return sessions[-(WARMUP + STEPS):]


def _prices(rows: list[dict], code: str, sessions: list[str]) -> tuple[float, ...]:
    expected_code = code + "0" if len(code) == 4 else code
    prices = {}
    for row in rows:
        try:
            day = _parse_date(row["Date"]).isoformat()
            if row["Code"] != expected_code or day not in sessions:
                raise ValueError("wrong code or date")
            if day in prices:
                raise MarketError("duplicate_price", "同じ営業日の株価が重複しています。")
            close, factor = row["C"], row["AdjFactor"]
            if any(type(x) not in (int, float) or not math.isfinite(x) or x <= 0 for x in (close, factor)):
                raise ValueError("invalid price or factor")
            if factor != 1:
                raise MarketError("corporate_action", "準備・対戦期間に株式分割等の調整（AdjFactor != 1）があります。別の終了日を選んでください。")
            prices[day] = float(close)
        except (KeyError, TypeError, ValueError, OverflowError):
            raise MarketError("invalid_price", "株価に欠損・0・非数値・銘柄違い・期間外データ、または不正な調整係数があります。補完はしません。") from None
    if set(prices) != set(sessions):
        raise MarketError("missing_sessions", "営業日の株価が不足しています。40営業日＋12営業日の連続した終値が必要です。補完はしません。")
    return tuple(prices[d] for d in sessions)


def run_market_replay(payload: object, models: dict) -> dict:
    code, end = validate_request(payload)
    client = JQuantsClient()
    start = max(date.min, end - timedelta(days=min(180, (end - date.min).days)))
    sessions = _sessions(client.rows(CALENDAR_PATH, {"from": start.isoformat(), "to": end.isoformat()}), start, end)
    rows = client.rows(BARS_PATH, {"code": code, "from": sessions[0], "to": sessions[-1]})
    prices = _prices(rows, code, sessions)
    # Split once; the predictor never receives prices[WARMUP:] as its history.
    result = compare_prices(prices[:WARMUP], prices[WARMUP:], models)
    canonical = {"code": code + "0" if len(code) == 4 else code, "price_field": "C",
                 "series": [[day, price] for day, price in zip(sessions, prices)]}
    digest = hashlib.sha256(json.dumps(canonical, ensure_ascii=True, sort_keys=True,
                                       separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    for item in result["contestants"].values():
        for i, row in enumerate(item["history"]):
            row.update({"decision_date": sessions[WARMUP - 1 + i],
                        "target_date": sessions[WARMUP + i],
                        "actual_price": prices[WARMUP + i]})
    result.update({
        "mode": "HISTORICAL_MARKET_REPLAY_NOT_FORWARD_VALIDATION",
        "scenario_name": f"日本株 {code} 実相場リプレイ", "steps": STEPS,
        "warning": WARNING, "market": {
            "code": canonical["code"], "requested_code": code,
            "requested_end_date": end.isoformat(), "provider": PROVIDER,
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "warmup_start_date": sessions[0], "warmup_end_date": sessions[WARMUP - 1],
            "warmup_sessions": WARMUP, "prediction_start_date": sessions[WARMUP - 1],
            "first_target_date": sessions[WARMUP], "final_date": sessions[-1],
            "price_field": "C", "price_series_sha256": digest,
            "calendar_verified": True, "corporate_action_policy": "reject_AdjFactor_not_1",
            "baseline_policy": "Laplace(1,1,1); prior replay outcomes only, no warmup labels",
            "local_only": True,
        },
        "score_axes": {
            "brier": "低いほど良い。次の営業日の方向に対する確率予測の二乗誤差平均",
            "profit": "高いほど良い。例示手数料0.1%込みの仮想コイン損益",
            "drawdown": "低いほど良い。仮想コイン資産の最大ピーク比下落率",
        },
    })
    return result

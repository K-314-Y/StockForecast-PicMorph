"""Invented fixtures in J-Quants V2 format, never an online success claim."""
import copy
import hashlib
import io
import json
import os
import unittest
from datetime import date, timedelta
from http.client import IncompleteRead
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

import app
import market
from challenge import KEYS, SCENARIOS, _simulate, run_challenge
from engine import Model, prediction
from game import PRESETS

MODELS = {"mine": Model(), **PRESETS}
FAKE_KEY = "mock-only-never-a-real-credential"
END = date(2025, 6, 30)
START = END - timedelta(days=180)
PAYLOAD = {"code": "7203", "end_date": END.isoformat()}


def fixtures():
    calendar = [{"Date": (START + timedelta(days=i)).isoformat(),
                 "HolDiv": "1" if (START + timedelta(days=i)).weekday() < 5 else "0"}
                for i in range(181)]
    dates = [r["Date"] for r in calendar if r["HolDiv"] == "1"][-52:]
    # Deliberately fabricated: not copied from J-Quants or any real stock.
    bars = [{"Date": day, "Code": "72030", "C": 2000.0 + i * 23,
             "AdjFactor": 1.0, "AdjC": -999.0} for i, day in enumerate(dates)]
    return calendar, bars


def response(payload, raw=None, status=200):
    result = io.BytesIO(json.dumps(payload).encode() if raw is None else raw)
    result.status = status
    return result


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"JQUANTS_API_KEY": FAKE_KEY})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.calendar, self.bars = fixtures()

    def replay(self, calendar=None, bars=None, payload=None):
        pages = [response({"data": self.calendar if calendar is None else calendar}),
                 response({"data": self.bars if bars is None else bars})]
        with patch("market.build_opener") as build:
            build.return_value.open.side_effect = pages
            result = market.run_market_replay(PAYLOAD if payload is None else payload, MODELS)
            self.requests = [call.args[0] for call in build.return_value.open.call_args_list]
        return result

    def assert_error(self, code, **kwargs):
        with self.assertRaises(market.MarketError) as caught:
            self.replay(**kwargs)
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn(FAKE_KEY, str(caught.exception))

    def test_mock_success_metadata_and_raw_c_only(self):
        result = self.replay(bars=list(reversed(self.bars)))
        self.assertEqual(result["steps"], 12)
        self.assertEqual(result["initial_coins_each"], 10000)
        self.assertEqual(result["market"]["code"], "72030")
        self.assertEqual(result["market"]["warmup_sessions"], 40)
        self.assertEqual(result["market"]["prediction_start_date"], self.bars[39]["Date"])
        self.assertEqual(result["market"]["first_target_date"], self.bars[40]["Date"])
        self.assertEqual(result["market"]["final_date"], self.bars[-1]["Date"])
        canonical = {"code": "72030", "price_field": "C",
                     "series": [[r["Date"], r["C"]] for r in self.bars]}
        digest = hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(result["market"]["price_series_sha256"], digest)
        self.assertTrue(result["market"]["calendar_verified"])
        self.assertFalse(result["has_overall_winner"])
        self.assertNotIn(FAKE_KEY, json.dumps(result))
        for request in self.requests:
            self.assertEqual(urlsplit(request.full_url).netloc, "api.jquants.com")
            self.assertEqual(request.get_header("X-api-key"), FAKE_KEY)
            self.assertNotIn(FAKE_KEY, request.full_url)
        query = parse_qs(urlsplit(self.requests[1].full_url).query)
        self.assertEqual(query, {"code": ["7203"], "from": [self.bars[0]["Date"]], "to": [self.bars[-1]["Date"]]})
        for item in result["contestants"].values():
            self.assertEqual(len(item["history"]), 12)
            self.assertEqual(len(item["equity_path"]), 13)
            self.assertEqual(item["history"][0]["observed_price"], self.bars[39]["C"])
            self.assertEqual(item["history"][0]["actual_price"], self.bars[40]["C"])
            self.assertEqual(item["history"][0]["decision_date"], self.bars[39]["Date"])
            self.assertTrue(0 <= item["brier_mean"] <= 2)
        for base in result["baselines"].values():
            self.assertEqual(base["history"][0]["prediction"], dict.fromkeys(KEYS, 1/3))

    def test_five_digit_code_and_same_hash(self):
        first = self.replay()
        second = self.replay(payload={**PAYLOAD, "code": "72030"})
        self.assertEqual(first["market"]["price_series_sha256"], second["market"]["price_series_sha256"])

    def test_exact_prefix_at_all_36_forecasts(self):
        seen = []
        prices = tuple(r["C"] for r in self.bars)
        def inspect(model, history):
            step = len(seen) % 12
            self.assertEqual(history, prices[:40 + step])
            seen.append(history)
            return prediction(model, history)
        with patch("challenge.prediction", side_effect=inspect):
            self.replay()
        self.assertEqual(len(seen), 36)

    def test_altered_future_does_not_change_prior_predictions_actions_or_baselines(self):
        initial = self.replay()
        altered = copy.deepcopy(self.bars)
        for i in range(45, 52):
            altered[i]["C"] = 300 + i
        later = self.replay(bars=altered)
        for slot in MODELS:
            for i in range(6):
                for key in ("prediction", "action"):
                    self.assertEqual(initial["contestants"][slot]["history"][i][key], later["contestants"][slot]["history"][i][key])
        for key in initial["baselines"]:
            for i in range(6):
                self.assertEqual(initial["baselines"][key]["history"][i]["prediction"], later["baselines"][key]["history"][i]["prediction"])
        self.assertNotEqual(initial["market"]["price_series_sha256"], later["market"]["price_series_sha256"])

    def test_coin_math_uses_market_boundary_price(self):
        with patch("challenge.prediction", return_value={"UP": 1, "FLAT": 0, "DOWN": 0}):
            result = _simulate(Model(risk_fraction=1), (2200,), price_history=(2000,) * 40)
        self.assertAlmostEqual(result["profit_coins"], round(10000 / 1.001 * 1.1 - 10000, 2))
        self.assertEqual(result["brier_mean"], 0)

    def test_request_strict_validation(self):
        for code in (7203, True, None, [], "123", "123456", "７２０３", "7203\n", " 7203", "720A", "http://localhost"):
            with self.subTest(code=code), self.assertRaises(market.MarketError):
                market.validate_request({**PAYLOAD, "code": code})
        for day in (None, 20250101, "2025-2-03", "2025-02-29", "2025-13-01", "2025-06-30\n", "20250630", "2025-06-30T00:00:00", "９９９９-01-01"):
            with self.subTest(day=day), self.assertRaises(market.MarketError):
                market.validate_request({**PAYLOAD, "end_date": day})
        with patch("market.today_jst", return_value=END):
            for day in (END, END + timedelta(days=1)):
                with self.assertRaises(market.MarketError):
                    market.validate_request({**PAYLOAD, "end_date": day.isoformat()})
        for payload in ([], None, {}, {**PAYLOAD, "url": "https://example.com"}, {**PAYLOAD, "api_key": FAKE_KEY}):
            with self.subTest(payload=type(payload)), self.assertRaises(market.MarketError):
                market.validate_request(payload)

    def test_missing_or_invalid_key_never_fetches_or_falls_back(self):
        for key in ("", "\n", " abc", "abc\r\nsecret", "非ASCII"):
            with patch.dict(os.environ, {"JQUANTS_API_KEY": key}), patch("market.build_opener") as build:
                self.assertFalse(market.market_status()["configured"])
                with self.assertRaises(market.MarketError) as caught:
                    market.run_market_replay(PAYLOAD, MODELS)
                self.assertEqual(caught.exception.code, "not_configured")
                build.assert_not_called()

    def test_split_rejected_at_every_boundary(self):
        for index in (0, 20, 39, 40, 51):
            for factor in (.5, 2, .999999):
                bars = copy.deepcopy(self.bars)
                bars[index]["AdjFactor"] = factor
                with self.subTest(index=index, factor=factor):
                    self.assert_error("corporate_action", bars=bars)

    def test_invalid_close_and_factor_rejected(self):
        for field in ("C", "AdjFactor"):
            for value in (None, 0, -1, True, "123", float("nan"), float("inf"), 10**400):
                bars = copy.deepcopy(self.bars)
                bars[40][field] = value
                with self.subTest(field=field, value=type(value)):
                    self.assert_error("invalid_price", bars=bars)
            bars = copy.deepcopy(self.bars)
            del bars[39][field]
            self.assert_error("invalid_price", bars=bars)

    def test_missing_duplicate_wrong_symbol_and_dates(self):
        for index in (0, 39, 40, 51):
            self.assert_error("missing_sessions", bars=self.bars[:index] + self.bars[index+1:])
        self.assert_error("missing_sessions", bars=[])
        self.assert_error("duplicate_price", bars=self.bars + [self.bars[40]])
        for field, value in (("Code", "72031"), ("Code", 72030), ("Date", "2025-01-01"), ("Date", "bad")):
            bars = copy.deepcopy(self.bars)
            bars[1][field] = value
            self.assert_error("invalid_price", bars=bars)

    def test_calendar_missing_duplicate_unknown_and_short_history(self):
        self.assert_error("incomplete_calendar", calendar=[])
        self.assert_error("incomplete_calendar", calendar=self.calendar[:-1])
        self.assert_error("invalid_calendar", calendar=self.calendar + [self.calendar[0]])
        for value in ("9", None, 1):
            calendar = copy.deepcopy(self.calendar)
            calendar[-1]["HolDiv"] = value
            self.assert_error("invalid_calendar", calendar=calendar)
        self.assert_error("insufficient_history", calendar=[{**r, "HolDiv": "0"} for r in self.calendar])

    def test_weekend_end_holidays_and_half_days(self):
        calendar = copy.deepcopy(self.calendar)
        calendar[-1]["HolDiv"] = "3"  # OSE holiday trading is not equities trading.
        calendar[-4]["HolDiv"] = "2"  # TSE half day is a valid equities session.
        expected = [r["Date"] for r in calendar if r["HolDiv"] in ("1", "2")][-52:]
        bars = [{**self.bars[i], "Date": d} for i, d in enumerate(expected)]
        result = self.replay(calendar=calendar, bars=bars)
        self.assertEqual(result["market"]["final_date"], "2025-06-27")

    def test_legacy_payload_hashes_unchanged(self):
        expected = {"rising": "89e18dda4ce3bea38d47c285b8d6a5af956406a5473426dc733f666fb58f29e2",
                    "falling": "ad2d7906997093421afe1ea75300e20b456089dec1a2df6968c0a2c710f94beb",
                    "sideways": "f708e4fbf91077718be920751cd3a2d09a1114bd91872e197c747b7e3de62e22"}
        for key in SCENARIOS:
            actual = hashlib.sha256(json.dumps(run_challenge(key, MODELS), sort_keys=True).encode()).hexdigest()
            self.assertEqual(actual, expected[key])


class TransportTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, {"JQUANTS_API_KEY": FAKE_KEY})
        env.start()
        self.addCleanup(env.stop)

    def test_v2_pagination_keeps_code_dates_and_encodes_token(self):
        with patch("market.build_opener") as build:
            build.return_value.open.side_effect = [response({"data": [{"n": 1}], "pagination_key": "abc/+?=&"}), response({"data": [{"n": 2}]})]
            client = market.JQuantsClient()
            query = {"code": "72030", "from": "2025-01-01", "to": "2025-02-01"}
            self.assertEqual(client.rows(market.BARS_PATH, query), [{"n": 1}, {"n": 2}])
            requests = build.return_value.open.call_args_list
            parsed = parse_qs(urlsplit(requests[1].args[0].full_url).query)
            self.assertEqual(parsed, {**{k: [v] for k, v in query.items()}, "pagination_key": ["abc/+?=&"]})
            self.assertNotIn("pagination_key", query)

    def test_calendar_pagination_and_page_boundary_duplicate(self):
        calendar, bars = fixtures()
        with patch("market.build_opener") as build:
            build.return_value.open.side_effect = [response({"data": calendar[:90], "pagination_key": "next"}), response({"data": calendar[90:]}), response({"data": bars[:40], "pagination_key": "next"}), response({"data": bars[39:]})]
            with self.assertRaises(market.MarketError) as caught:
                market.run_market_replay(PAYLOAD, MODELS)
            self.assertEqual(caught.exception.code, "duplicate_price")

    def test_upstream_errors_redacted(self):
        for status in (401, 403, 429, 500, 302):
            error = HTTPError("https://example.com/" + FAKE_KEY, status, FAKE_KEY, {}, io.BytesIO(FAKE_KEY.encode()))
            with patch("market.build_opener") as build:
                build.return_value.open.side_effect = error
                with self.assertRaises(market.MarketError) as caught:
                    market.JQuantsClient().rows(market.BARS_PATH, {})
                self.assertEqual(caught.exception.code, f"upstream_{status}")
                self.assertNotIn(FAKE_KEY, str(caught.exception))
                self.assertEqual(build.return_value.open.call_count, 1)
        for error in (URLError(FAKE_KEY), TimeoutError(FAKE_KEY), OSError(FAKE_KEY), IncompleteRead(b"mock")):
            with patch("market.build_opener") as build:
                build.return_value.open.side_effect = error
                with self.assertRaises(market.MarketError) as caught:
                    market.JQuantsClient().rows(market.BARS_PATH, {})
                self.assertEqual(caught.exception.code, "network_error")
                self.assertNotIn(FAKE_KEY, str(caught.exception))

    def test_invalid_response_shape_encoding_and_size(self):
        for body in (b"not json", b"\xff", b"[]", b'{"daily_quotes": []}', b'{"data": null}', b'{"data": {}}', b"x" * (market.MAX_BYTES + 1)):
            with patch("market.build_opener") as build:
                build.return_value.open.return_value = response(None, raw=body)
                with self.assertRaises(market.MarketError):
                    market.JQuantsClient().rows(market.BARS_PATH, {})

    def test_pagination_loop_invalid_token_limits_and_bad_endpoint(self):
        for key in (1, [], "x" * 4097):
            with patch("market.build_opener") as build:
                build.return_value.open.return_value = response({"data": [], "pagination_key": key})
                with self.assertRaises(market.MarketError):
                    market.JQuantsClient().rows(market.BARS_PATH, {})
        for keys in (("again", "again"), tuple(str(i) for i in range(market.MAX_PAGES))):
            with patch("market.build_opener") as build:
                build.return_value.open.side_effect = [response({"data": [], "pagination_key": k}) for k in keys]
                with self.assertRaises(market.MarketError):
                    market.JQuantsClient().rows(market.BARS_PATH, {})
        with patch("market.build_opener") as build:
            client = market.JQuantsClient()
            with self.assertRaises(market.MarketError):
                client.rows("https://example.com/", {})
            build.return_value.open.assert_not_called()
        self.assertIsNone(market._NoRedirect().redirect_request(None, None, 302, "", {}, "https://example.com"))


class MemoryConnection:
    """Exercise real HTTP request parsing/headers/handlers without opening TCP."""
    def __init__(self, request):
        self.input = io.BytesIO(request)
        self.output = bytearray()

    def makefile(self, *args):
        return self.input

    def sendall(self, value):
        self.output.extend(value)


def http_request(path, payload=None, *, method=None, headers=None, peer="127.0.0.1", raw=None):
    body = raw if raw is not None else (json.dumps(payload).encode() if payload is not None else b"")
    method = method or ("POST" if payload is not None or raw is not None else "GET")
    fields = {"Host": "127.0.0.1:8765", "Content-Type": "application/json", "Content-Length": str(len(body)), **(headers or {})}
    wire = f"{method} {path} HTTP/1.0\r\n" + "".join(f"{k}: {v}\r\n" for k, v in fields.items()) + "\r\n"
    connection = MemoryConnection(wire.encode() + body)
    app.Handler(connection, (peer, 12345), SimpleNamespace(server_port=8765))
    head, body = bytes(connection.output).split(b"\r\n\r\n", 1)
    return int(head.split()[1]), head.decode(), body


class HTTPHandlerTests(unittest.TestCase):
    def test_get_status_no_key_or_network(self):
        with patch.dict(os.environ, {"JQUANTS_API_KEY": ""}), patch("market.build_opener") as build:
            status, headers, body = http_request("/api/market/status")
            self.assertEqual(status, 200)
            self.assertIn("Cache-Control: no-store", headers)
            self.assertNotIn("Access-Control-Allow-Origin", headers)
            self.assertFalse(json.loads(body)["configured"])
            build.assert_not_called()
        with patch.dict(os.environ, {"JQUANTS_API_KEY": FAKE_KEY}):
            self.assertNotIn(FAKE_KEY.encode(), http_request("/api/market/status")[2])

    def test_post_missing_key_and_invalid_input(self):
        with patch.dict(os.environ, {"JQUANTS_API_KEY": ""}):
            status, _, body = http_request("/api/market/replay", PAYLOAD)
            self.assertEqual(status, 503)
            self.assertEqual(json.loads(body)["error_code"], "not_configured")
        for payload in ({**PAYLOAD, "url": "https://example.com"}, {**PAYLOAD, "code": FAKE_KEY}, {**PAYLOAD, "expected_revision": 0}):
            status, _, body = http_request("/api/market/replay", payload)
            self.assertEqual(status, 400)
            self.assertNotIn(FAKE_KEY.encode(), body)
        self.assertEqual(http_request("/api/market/replay", raw=b"not-json")[0], 400)

    def test_get_and_post_reject_remote_hosts_origins_proxies_and_peers(self):
        for path, payload in (("/api/market/status", None), ("/api/market/replay", PAYLOAD)):
            for headers in ({"Host": "example.com"}, {"Origin": "https://example.com"}, {"Sec-Fetch-Site": "cross-site"}, {"X-Forwarded-For": "127.0.0.1"}, {"Forwarded": "for=127.0.0.1"}):
                self.assertEqual(http_request(path, payload, headers=headers)[0], 403)
            self.assertEqual(http_request(path, payload, peer="192.0.2.1")[0], 403)
        self.assertEqual(http_request("/api/market/replay", PAYLOAD, headers={"Content-Type": "text/plain"})[0], 415)

    def test_success_snapshots_revisions_and_never_writes_state(self):
        calendar, bars = fixtures()
        before = copy.deepcopy(app.STATE)
        with patch.dict(os.environ, {"JQUANTS_API_KEY": FAKE_KEY}), patch("market.build_opener") as build, patch("app.effective_models", return_value={}), patch("app.equipped_models", side_effect=lambda models: models), patch("app.lineup_snapshot", return_value={"revision": 7}), patch("app.public_growth", return_value={"revision": 9}):
            build.return_value.open.side_effect = [response({"data": calendar}), response({"data": bars})]
            status, _, body = http_request("/api/market/replay", PAYLOAD)
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertEqual(result["source_revision"], before["revision"])
        self.assertEqual(result["lineup_revision"], 7)
        self.assertEqual(result["growth_revision"], 9)
        self.assertEqual(app.STATE, before)
        self.assertNotIn(FAKE_KEY.encode(), body)

    def test_busy_and_error_release_lock_and_no_model_lock_during_fetch(self):
        with patch("app.run_market_replay") as replay:
            app.MARKET_LOCK.acquire()
            try:
                self.assertEqual(http_request("/api/market/replay", PAYLOAD)[0], 429)
                replay.assert_not_called()
            finally:
                app.MARKET_LOCK.release()
        def fail(*args):
            self.assertFalse(app.LOCK.locked())
            raise market.MarketError("network_error", "接続できません", 502)
        with patch("app.run_market_replay", side_effect=fail):
            self.assertEqual(http_request("/api/market/replay", PAYLOAD)[0], 502)
        self.assertFalse(app.MARKET_LOCK.locked())

    def test_existing_http_routes_and_synthetic_results(self):
        for path in ("/", "/game", "/api/state", "/api/meta", "/api/versions", "/api/plugins", "/api/lineup", "/api/growth", "/api/challenge/scenarios"):
            self.assertEqual(http_request(path)[0], 200, path)
        self.assertEqual(http_request("/api/not-found")[0], 404)
        for scenario in SCENARIOS:
            status, _, body = http_request("/api/challenge/run", {"scenario_id": scenario})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)["mode"], "FIXED_SYNTHETIC_CHALLENGE_NOT_VALIDATION")
        self.assertEqual(http_request("/api/practice", {"allocations": {"mine": 40, "owl": 30, "turtle": 20}})[0], 200)


if __name__ == "__main__":
    unittest.main()

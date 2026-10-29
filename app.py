"""Local-only Creature Lab. Market data stays in the private replay response."""
from __future__ import annotations

import argparse
import json
import ipaddress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import urlsplit

from engine import Model, PLUGIN_INFO, model_from_python, view, with_visual_change, with_plugin_change, with_plugin_strength_change
from game import read_versions, save_version, load_version, run_practice
from lineup import lineup_snapshot, assign_model, effective_models
from game import PRESETS
from growth import public_growth, complete_training, equip, equipped_models
from challenge import public_scenarios, run_challenge
from market import MarketError, market_status, run_market_replay
import blueprints
import training_lab

ROOT = Path(__file__).resolve().parent
LOCK = Lock()
MARKET_LOCK = Lock()
STATE = {"model": Model(), "revision": 0}


def snapshot() -> dict:
    with LOCK:
        return view(STATE["model"], STATE["revision"])


class Handler(BaseHTTPRequestHandler):
    server_version = "CreatureLab/0.1"

    def log_message(self, format, *args):
        return

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, result: dict) -> None:
        self._send(code, json.dumps(result, ensure_ascii=False).encode(),
                   "application/json; charset=utf-8")

    def _market_access(self, message="実相場機能は同じ端末のローカル画面からのみ利用できます。") -> bool:
        """Guard both new routes, including GET, against remote browser access."""
        allowed = (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}")
        try:
            local = ipaddress.ip_address(self.client_address[0]).is_loopback
        except ValueError:
            local = False
        origin = self.headers.get("Origin")
        if (not local or self.headers.get("Host") not in allowed
                or (origin and origin not in tuple("http://" + host for host in allowed))
                or self.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none")
                or any(self.headers.get(h) for h in ("Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"))):
            self._json(403, {"error": message})
            return False
        return True

    def _blueprint_access(self):
        return self._market_access("制作機能は同じ端末のローカル画面からのみ利用できます。")

    def _blueprint_post(self, path):
        if not self._blueprint_access():
            return
        try:
            training = path in ("/api/blueprints/train-preview", "/api/blueprints/train-save")
            if not training and path not in ("/api/blueprints/preview", "/api/blueprints/create"):
                raise blueprints.BlueprintError("見つかりません", 404)
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                raise blueprints.BlueprintError("JSONのみ受け付けます", 415)
            lengths = self.headers.get_all("Content-Length", [])
            if self.headers.get("Transfer-Encoding") or len(lengths) != 1:
                raise blueprints.BlueprintError("Content-Lengthを1つ指定してください")
            size = int(lengths[0])
            limit = training_lab.MAX_REQUEST_BYTES if training else blueprints.MAX_REQUEST_BYTES
            if not 0 < size <= limit:
                raise blueprints.BlueprintError("入力サイズが上限を超えています", 413)
            raw = self.rfile.read(size)
            if len(raw) != size:
                raise blueprints.BlueprintError("入力が途中で切れています")
            payload = json.loads(raw)
            if not isinstance(payload, dict) or "action" in payload:
                raise blueprints.BlueprintError("制作設定をJSONオブジェクトで指定してください")
            if training:
                save = path.endswith("/train-save")
                self._json(201 if save else 200,
                           training_lab.train_save(payload) if save else training_lab.train_preview(payload))
                return
            payload["action"] = "preview" if path.endswith("/preview") else "save"
            self._json(200 if payload["action"] == "preview" else 201,
                       blueprints.create_draft(payload))
        except blueprints.BlueprintError as exc:
            self._json(exc.status, {"error": str(exc)})
        except (ValueError, TypeError, RecursionError):
            self._json(400, {"error": "JSON入力が不正です"})

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/create" or path == "/api/blueprints" or path.startswith("/api/blueprints/"):
            if not self._blueprint_access():
                return
            try:
                if path == "/create":
                    self._send(200, (ROOT / "web" / "create.html").read_bytes(), "text/html; charset=utf-8")
                elif path == "/api/blueprints":
                    self._json(200, blueprints.read_drafts())
                elif path == "/api/blueprints/trained":
                    self._json(200, training_lab.read_trained())
                elif path.endswith("/image"):
                    mime, data = blueprints.read_image(path[len("/api/blueprints/"):-len("/image")])
                    self._send(200, data, mime)
                else:
                    self._json(404, {"error": "見つかりません"})
            except blueprints.BlueprintError as exc:
                self._json(exc.status, {"error": str(exc)})
        elif path == "/api/market/status":
            if self._market_access():
                self._json(200, market_status())
        elif path in ("/", "/game"):
            name = "index.html" if path == "/" else "game.html"
            body = (ROOT / "web" / name).read_bytes()
            self._send(200, body, "text/html; charset=utf-8")
        elif path == "/api/state":
            self._json(200, snapshot())
        elif path == "/api/meta":
            self._json(200, {
                "version": "0.9.0", "mode": "synthetic-local-only",
                "plugins": list(PLUGIN_INFO), "scenarios": public_scenarios(),
                "manual": (ROOT / "MANUAL_FOR_AI.md").read_text(encoding="utf-8"),
            })
        elif path == "/api/versions":
            with LOCK:
                self._json(200, {"versions": read_versions()})
        elif path == "/api/plugins":
            self._json(200, {"plugins": list(PLUGIN_INFO), "mode": "allowlisted-synthetic-only"})
        elif path == "/api/lineup":
            with LOCK:
                self._json(200, lineup_snapshot())
        elif path == "/api/growth":
            with LOCK:
                self._json(200, public_growth())
        elif path == "/api/challenge/scenarios":
            self._json(200, {"scenarios": public_scenarios()})
        else:
            self._json(404, {"error": "見つかりません"})

    def do_POST(self):
        path = urlsplit(self.path).path
        if path == "/api/blueprints" or path.startswith("/api/blueprints/"):
            self._blueprint_post(path)
            return
        if path.startswith("/api/market/") and not self._market_access():
            return
        origin = self.headers.get("Origin")
        host = self.headers.get("Host", "")
        if host not in (f"127.0.0.1:{self.server.server_port}",
                        f"localhost:{self.server.server_port}"):
            self._json(403, {"error": "ローカルアクセスのみ許可しています"})
            return
        if origin and origin not in (f"http://127.0.0.1:{self.server.server_port}",
                                    f"http://localhost:{self.server.server_port}"):
            self._json(403, {"error": "アクセス元が不正です"})
            return
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            self._json(415, {"error": "JSONのみ受け付けます"})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not (0 < size <= 8192):
                raise ValueError("入力が大きすぎます")
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError("JSONオブジェクトで指定してください")
            if path == "/api/market/replay":
                # Do not hold the model edit lock during provider I/O. Snapshot
                # models and all revisions together; this run never writes state.
                with LOCK:
                    models = equipped_models({"mine": STATE["model"], **PRESETS, **effective_models()})
                    revisions = {"source_revision": STATE["revision"],
                                 "lineup_revision": lineup_snapshot()["revision"],
                                 "growth_revision": public_growth()["revision"]}
                if not MARKET_LOCK.acquire(blocking=False):
                    raise MarketError("replay_busy", "別の実相場リプレイを取得中です。完了後に再実行してください。", 429)
                try:
                    result = run_market_replay(payload, models)
                finally:
                    MARKET_LOCK.release()
                self._json(200, {**result, **revisions})
                return
            with LOCK:
                # Writes from MCP must not silently overwrite a newer UI edit.
                expected_revision = payload.pop("expected_revision", None)
                if expected_revision is not None:
                    if type(expected_revision) is not int or expected_revision < 0:
                        raise ValueError("expected_revision は0以上の整数です")
                    if expected_revision != STATE["revision"]:
                        self._json(409, {"error": "revision conflict: 状態を読み直してください"})
                        return
                if path == "/api/visual":
                    if set(payload) - {"eye", "risk"}:
                        raise ValueError("対応していない装備設定です")
                    new = with_visual_change(
                        STATE["model"], eye=payload.get("eye"),
                        risk=payload.get("risk"),
                    )
                elif path == "/api/code":
                    if set(payload) != {"python"}:
                        raise ValueError("Pythonソースが必要です")
                    new = model_from_python(payload["python"])
                elif path == "/api/plugins":
                    if set(payload) != {"weights"}:
                        raise ValueError("weightsが必要です")
                    new = with_plugin_change(STATE["model"], payload["weights"])
                elif path == "/api/plugin-settings":
                    if set(payload) != {"strengths"}:
                        raise ValueError("strengthsが必要です")
                    new = with_plugin_strength_change(STATE["model"], payload["strengths"])
                elif path == "/api/lineup":
                    if set(payload) != {"slot","version_id","expected_lineup_revision"}:
                        raise ValueError("キャラ枠・保存モデル・編成revisionが必要です")
                    changed = assign_model(payload["slot"],payload["version_id"],
                                           payload["expected_lineup_revision"])
                    self._json(200, changed)
                    return
                elif path == "/api/challenge/run":
                    if set(payload) != {"scenario_id"}:
                        raise ValueError("scenario_idだけ指定してください")
                    models = equipped_models({
                        "mine": STATE["model"], **PRESETS, **effective_models()
                    })
                    outcome = run_challenge(payload["scenario_id"], models)
                    outcome["source_revision"] = STATE["revision"]
                    outcome["lineup_revision"] = lineup_snapshot()["revision"]
                    outcome["growth_revision"] = public_growth()["revision"]
                    self._json(200, outcome)
                    return
                elif path == "/api/training/complete":
                    if set(payload) != {"allocations","expected_growth_revision"}:
                        raise ValueError("練習配分と育成revisionを指定してください")
                    assigned_models=equipped_models({"mine":STATE["model"],**PRESETS,**effective_models()})
                    result=run_practice(STATE["model"],payload["allocations"],assigned=assigned_models)
                    training=complete_training(payload["allocations"],payload["expected_growth_revision"])
                    self._json(200, {"result":result,**training})
                    return
                elif path == "/api/growth/equip":
                    if set(payload) != {"slot","gear_id","expected_growth_revision"}:
                        raise ValueError("装備・キャラ枠・育成revisionを指定してください")
                    growth=equip(payload["slot"],payload["gear_id"],payload["expected_growth_revision"])
                    self._json(200,growth)
                    return
                elif path == "/api/reset":
                    if payload:
                        raise ValueError("リセットには引数は不要です")
                    new = Model()
                elif path == "/api/practice":
                    if set(payload) != {"allocations"}:
                        raise ValueError("allocationsだけ指定してください")
                    assigned_models=equipped_models({"mine":STATE["model"],**PRESETS,**effective_models()})
                    result = run_practice(STATE["model"], payload["allocations"],
                                          assigned=assigned_models)
                    result["growth_revision"] = public_growth()["revision"]
                    result["lineup_revision"] = lineup_snapshot()["revision"]
                    result["source_revision"] = STATE["revision"]
                    self._json(200, result)
                    return
                elif path == "/api/version/save":
                    if set(payload) != {"name"}:
                        raise ValueError("名前だけ指定してください")
                    entry = save_version(payload["name"], STATE["model"])
                    self._json(200, {"saved": entry, "versions": read_versions()})
                    return
                elif path == "/api/version/load":
                    if set(payload) != {"id"}:
                        raise ValueError("バージョンIDだけ指定してください")
                    new = load_version(payload["id"])
                else:
                    self._json(404, {"error": "見つかりません"})
                    return
                STATE["model"] = new
                STATE["revision"] += 1
                result = view(new, STATE["revision"])
            self._json(200, result)
        except MarketError as exc:
            self._json(exc.status, {"error": str(exc), "error_code": exc.code})
        except LookupError as exc:
            self._json(409, {"error": str(exc)})
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            self._json(400, {"error": "実相場リプレイの入力またはモデル設定が不正です。" if path.startswith("/api/market/") else str(exc)})


def main() -> None:
    parser = argparse.ArgumentParser(description="Prediction Creature Lab (local)")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"CREATURE_LAB_READY http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

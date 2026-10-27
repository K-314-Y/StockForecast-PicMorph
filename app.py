"""Local-only interactive Sprint 1. Standard library; no third-party services."""
from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import urlsplit

from engine import Model, PLUGIN_INFO, model_from_python, view, with_visual_change, with_plugin_change, with_plugin_strength_change
from game import read_versions, save_version, load_version, run_practice
from lineup import lineup_snapshot, assign_model, effective_models

ROOT = Path(__file__).resolve().parent
LOCK = Lock()
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

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/", "/game"):
            name = "index.html" if path == "/" else "game.html"
            body = (ROOT / "web" / name).read_bytes()
            self._send(200, body, "text/html; charset=utf-8")
        elif path == "/api/state":
            self._json(200, snapshot())
        elif path == "/api/versions":
            with LOCK:
                self._json(200, {"versions": read_versions()})
        elif path == "/api/plugins":
            self._json(200, {"plugins": list(PLUGIN_INFO), "mode": "allowlisted-synthetic-only"})
        elif path == "/api/lineup":
            with LOCK:
                self._json(200, lineup_snapshot())
        else:
            self._json(404, {"error": "見つかりません"})

    def do_POST(self):
        path = urlsplit(self.path).path
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
                elif path == "/api/reset":
                    if payload:
                        raise ValueError("リセットには引数は不要です")
                    new = Model()
                elif path == "/api/practice":
                    if set(payload) != {"allocations"}:
                        raise ValueError("allocationsだけ指定してください")
                    result = run_practice(STATE["model"], payload["allocations"],
                                          assigned=effective_models())
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
        except LookupError as exc:
            self._json(409, {"error": str(exc)})
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            self._json(400, {"error": str(exc)})


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

"""Persistent per-character assignment of archived safe models.

No user code is loaded/executed, only validated declarative versions.
Does not modify the current character or historical saved versions.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from engine import Model, PLUGIN_IDS
from game import ROOT, PRESETS, load_version, read_versions

LINEUP_FILE = ROOT / "local_state" / "lineup.json"
ASSIGNABLE = ("owl", "turtle")


def read_lineup() -> dict:
    if not LINEUP_FILE.exists():
        return {"schema": 1, "revision": 0, "assignments": {k: None for k in ASSIGNABLE}}
    with LINEUP_FILE.open(encoding="utf-8") as file:
        raw = json.load(file)
    if not isinstance(raw, dict) or raw.get("schema") != 1 or type(raw.get("revision")) is not int or raw["revision"] < 0:
        raise ValueError("キャラ編成ファイルが壊れています")
    ids = raw.get("assignments")
    if not isinstance(ids, dict) or set(ids) != set(ASSIGNABLE):
        raise ValueError("キャラの割当形式が不正です")
    if any(v is not None and (not isinstance(v, str) or len(v) != 32) for v in ids.values()):
        raise ValueError("キャラのモデルIDが不正です")
    return {"schema": 1, "revision": raw["revision"], "assignments": dict(ids)}


def effective_models() -> dict[str, Model]:
    assignments = read_lineup()["assignments"]
    return {k: load_version(v) for k, v in assignments.items() if v is not None}


def lineup_snapshot() -> dict:
    record = read_lineup()
    known = {x["id"]: x["name"] for x in read_versions()}
    slots = []
    for k in ASSIGNABLE:
        identity = record["assignments"][k]
        model = load_version(identity) if identity else PRESETS[k]
        slots.append({
            "slot": k, "version_id": identity,
            "name": known.get(identity) if identity else ("ルナ（標準）" if k == "owl" else "ミドリ（標準）"),
            "model": {
                "fast_window": model.fast_window, "slow_window": model.slow_window,
                "risk_fraction": model.risk_fraction,
                "plugin_weights": dict(zip(PLUGIN_IDS, model.plugin_weights)),
                "plugin_strengths": dict(zip(PLUGIN_IDS, model.plugin_strengths)),
            },
        })
    return {"revision": record["revision"], "assignments": record["assignments"], "slots": slots}


def assign_model(slot: object, version_id: object, expected_revision: object) -> dict:
    if slot not in ASSIGNABLE or type(slot) is not str:
        raise ValueError("ルナかミドリの枠を指定してください")
    if version_id is not None:
        if type(version_id) is not str:
            raise ValueError("保存モデルのIDが不正です")
        load_version(version_id)  # verify SHA & schema before modifying the lineup
    record = read_lineup()
    if type(expected_revision) is not int or expected_revision != record["revision"]:
        raise LookupError("lineup revision conflict: 編成を読み直してください")
    if record["assignments"][slot] == version_id:
        return lineup_snapshot()
    next_record = {
        "schema": 1, "revision": record["revision"] + 1,
        "assignments": {**record["assignments"], slot: version_id},
    }
    LINEUP_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".lineup-", dir=LINEUP_FILE.parent)
    try:
        with os.fdopen(fd,"w",encoding="utf-8") as file:
            json.dump(next_record,file,ensure_ascii=False,indent=2)
            file.flush(); os.fsync(file.fileno())
        os.replace(tmp,LINEUP_FILE)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return lineup_snapshot()

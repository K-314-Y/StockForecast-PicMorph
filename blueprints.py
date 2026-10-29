"""Offline, immutable draft recipes. No vision, training, or live model writes.

The visual asset, reusable capacity parts, recipe, future training job, and
future immutable deployed version have separate schema fields. Only built-in
indicator recipes are implemented; null job/version fields are not promises
of trained weights. One app process serializes its draft storage operations.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

from engine import Model
from indicators import REGISTRY

STORE_FILE = Path(__file__).resolve().parent / "local_state" / "created_blueprints.json"
MAX_IMAGE_BYTES = 1024 * 1024
MAX_REQUEST_BYTES = 4 * ((MAX_IMAGE_BYTES + 2) // 3) + 8192
MAX_DRAFTS = 50
MAX_ASSET_BYTES = 20 * MAX_IMAGE_BYTES
LOCK = Lock()
NOTICE = "絵のAI解析は未接続: イラストは外見、候補はあなたが選んだ性格・設定から生成"
TRAITS = {
    "energetic": ("元気", 3, 9, .45),
    "cautious": ("慎重", 8, 20, .20),
    "analytical": ("分析好き", 5, 15, .30),
    "balanced": ("バランス", 5, 12, .35),
}
RECIPES = {
    "trend": ("流れを追う案", {"trend": 50, "momentum": 30, "volatility": 10, "reversion": 10},
              "移動平均と直近の変化を重視します。流れの反転には追従が遅れる場合があります。"),
    "reversion": ("戻りを待つ案", {"trend": 15, "momentum": 10, "volatility": 20, "reversion": 55},
                  "価格が平均へ戻るという仮定を重視します。一方向の流れが続くと仮定が外れます。"),
    "balanced": ("広く見渡す案", {"trend": 30, "momentum": 20, "volatility": 25, "reversion": 25},
                 "4つの指標に重みを分けます。意見が相殺される場合があり、精度や安全性を保証しません。"),
}


class BlueprintError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _text(value, label, limit, *, required=False):
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 for c in value):
        raise BlueprintError(f"{label}は{limit}文字以内の1行で指定してください。")
    value = value.strip()
    if required and not value:
        raise BlueprintError(f"{label}を入力してください。")
    return value


def validate_image(value):
    """Strict data URI + container signatures, never execute or decode pixels.

    This is not a full image decoder. Browser rendering handles damaged image
    bodies; isolated image responses cannot be interpreted as HTML or SVG.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise BlueprintError("画像はPNG・JPEG・WebPのdata URIで指定してください。")
    if len(value) > 4 * ((MAX_IMAGE_BYTES + 2) // 3) + 32:
        raise BlueprintError("画像は1 MB以下にしてください。", 413)
    match = re.fullmatch(r"data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})", value)
    if not match:
        raise BlueprintError("PNG・JPEG・WebPのbase64画像だけ添付できます。")
    mime, encoded = match.groups()
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise BlueprintError("画像のbase64が不正です。") from exc
    if len(data) > MAX_IMAGE_BYTES:
        raise BlueprintError("画像は1 MB以下にしてください。", 413)
    valid = {
        "image/png": (len(data) >= 45 and data.startswith(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR")
                      and data.endswith(b"\0\0\0\0IEND\xaeB`\x82")
                      and 0 < int.from_bytes(data[16:20], "big") <= 4096
                      and 0 < int.from_bytes(data[20:24], "big") <= 4096),
        "image/jpeg": len(data) >= 32 and data.startswith(b"\xff\xd8\xff") and data.endswith(b"\xff\xd9"),
        "image/webp": (len(data) >= 30 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
                       and data[12:16] in (b"VP8 ", b"VP8L", b"VP8X")
                       and int.from_bytes(data[4:8], "little") == len(data) - 8),
    }[mime]
    if not valid:
        raise BlueprintError("画像の実データと形式が一致しないか、画像が壊れています。")
    return mime, data


def candidates(declared):
    """Map declared traits only; concept/style text is retained, not analyzed."""
    specs = {spec.id: spec for spec in REGISTRY}
    required = set(RECIPES["balanced"][1])
    if not required <= specs.keys():
        raise BlueprintError("制作案に必要な内蔵指標が登録されていません。", 503)
    trait = declared["trait"]
    label, fast, slow, risk = TRAITS[trait]
    result = []
    for key, (title, base, explanation) in RECIPES.items():
        weights = {spec.id: base.get(spec.id, 0) for spec in REGISTRY}
        shift = {"energetic": ("volatility", "momentum"),
                 "cautious": ("momentum", "volatility"),
                 "analytical": ("momentum", "reversion")}.get(trait)
        if shift:
            weights[shift[0]] -= 5
            weights[shift[1]] += 5
        strengths = {spec.id: spec.public_info()["parameters"][0]["default"] for spec in REGISTRY}
        if trait == "energetic":
            strengths.update(trend=110, momentum=110)
        elif trait == "cautious":
            strengths = {key: 90 for key in strengths}
        elif trait == "analytical":
            strengths["reversion"] = 110
        for spec in REGISTRY:
            limits = spec.public_info()["parameters"][0]
            if not limits["min"] <= strengths[spec.id] <= limits["max"]:
                raise BlueprintError("指標の感度が登録範囲外です。", 503)
        # Same validator as the current engine, with its actual registry order.
        Model(fast, slow, risk, tuple(weights[s.id] for s in REGISTRY),
              tuple(strengths[s.id] for s in REGISTRY))
        result.append({
            "candidate_id": key, "title": title,
            "reasoning": (f"あなたが選んだ「{label}」から期間を{fast}/{slow}、仮想配分比率を{risk:.0%}に設定。"
                          + explanation + " 性格は設計上の対応表に使うだけで、予測能力の証拠ではありません。"),
            "capacity_parts": [{"id": "indicator:" + s.id, "kind": "builtin_indicator",
                                "indicator_id": s.id, "name": s.name} for s in REGISTRY],
            "blueprint": {"kind": "indicator_composition_v1",
                          "capacity_part_ids": ["indicator:" + s.id for s in REGISTRY],
                          "engine_parameters": {"fast_window": fast, "slow_window": slow,
                                                "risk_fraction": risk, "plugin_weights": weights,
                                                "plugin_strengths": strengths}},
        })
    return result


def _paths():
    directory = STORE_FILE.parent
    assets = directory / "created_visual_assets"
    if any(p.is_symlink() for p in (directory, STORE_FILE, assets)):
        raise BlueprintError("下書き保存先が不正です。", 500)
    return directory, assets


def _read():
    _paths()
    if not STORE_FILE.exists():
        return []
    try:
        if STORE_FILE.stat().st_size > MAX_DRAFTS * 16384:
            raise ValueError()
        raw = json.loads(STORE_FILE.read_text(encoding="utf-8"))
        if (not isinstance(raw, dict) or raw.get("schema") != 1
                or not isinstance(raw.get("drafts"), list) or len(raw["drafts"]) > MAX_DRAFTS):
            raise ValueError()
        for draft in raw["drafts"]:
            validate_id(draft["id"])
            if draft["status"] != "draft" or draft["competition_eligible"] is not False:
                raise ValueError()
        return raw["drafts"]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise BlueprintError("下書き保存データを読み取れません。上書きせず停止しました。", 500) from exc


def validate_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"bp_[a-f0-9]{32}", value):
        raise BlueprintError("下書きIDが不正です。")
    return value


def read_drafts(draft_id=None):
    if draft_id is not None:
        validate_id(draft_id)
    with LOCK:
        drafts = _read()
    if draft_id is None:
        # Metadata/recipes only: no base64 or raw image bytes in the catalog.
        return {"drafts": list(reversed(drafts)), "notice": NOTICE, "limit": MAX_DRAFTS}
    for draft in drafts:
        if draft["id"] == draft_id:
            return {"draft": draft, "notice": NOTICE}
    raise BlueprintError("下書きが見つかりません。", 404)


def read_image(draft_id):
    draft = read_drafts(draft_id)["draft"]
    asset = draft["visual_asset"]
    if asset is None:
        raise BlueprintError("添付イラストはありません。", 404)
    _, assets = _paths()
    # Filename is derived only from the validated draft ID, never user input.
    path = assets / (validate_id(draft_id) + ".image")
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_IMAGE_BYTES:
        raise BlueprintError("添付イラストを読み取れません。", 404)
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != asset["sha256"]:
        raise BlueprintError("添付イラストの整合性を確認できません。", 500)
    return asset["media_type"], data


def create_draft(payload):
    allowed = {"action", "name", "concept", "style", "trait", "image_data_uri", "candidate_id"}
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise BlueprintError("対応していない制作設定です。")
    action = payload.get("action")
    if action not in ("preview", "save"):
        raise BlueprintError("actionはpreviewまたはsaveです。")
    if (action == "preview" and "candidate_id" in payload
            or action == "save" and (not isinstance(payload.get("candidate_id"), str)
                                      or payload["candidate_id"] not in RECIPES)):
        raise BlueprintError("保存する制作案を3つの候補から選んでください。")
    declared = {"name": _text(payload.get("name"), "名前", 60, required=True),
                "concept": _text(payload.get("concept", ""), "設定", 300),
                "style": _text(payload.get("style", ""), "外見のメモ", 100)}
    trait = payload.get("trait")
    if not isinstance(trait, str) or trait not in TRAITS:
        raise BlueprintError("性格を選んでください。")
    declared["trait"] = trait
    image = validate_image(payload.get("image_data_uri"))
    options = candidates(declared)
    common = {"notice": NOTICE, "generator": {"kind": "declared_traits_rules", "version": 1,
              "vision_used": False, "text_analysis_used": False}, "user_declared": declared}
    if action == "preview":
        return {**common, "candidates": options, "image_attached": image is not None}
    selected = next(c for c in options if c["candidate_id"] == payload["candidate_id"])
    draft_id = "bp_" + uuid.uuid4().hex
    asset = None if image is None else {
        "id": "asset_" + uuid.uuid4().hex, "kind": "local_illustration", "media_type": image[0],
        "bytes": len(image[1]), "sha256": hashlib.sha256(image[1]).hexdigest(),
        "url": f"/api/blueprints/{draft_id}/image", "analyzed": False,
    }
    draft = {"schema": 1, "id": draft_id, "created_at": datetime.now(timezone.utc).isoformat(),
             **common, **selected, "visual_asset": asset, "status": "draft",
             "training_job": None, "deployed_model_version": None, "competition_eligible": False}
    with LOCK:
        drafts = _read()
        if len(drafts) >= MAX_DRAFTS:
            raise BlueprintError("下書きの保存上限50件に達しました。", 413)
        directory, assets = _paths()
        files = list(assets.iterdir()) if assets.exists() else []
        if any(p.is_symlink() or not p.is_file() for p in files):
            raise BlueprintError("イラスト保存先が不正です。", 500)
        if image and (len(files) >= MAX_DRAFTS or sum(p.stat().st_size for p in files) + len(image[1]) > MAX_ASSET_BYTES):
            raise BlueprintError("イラスト保存上限（50枚・合計20 MB）に達しました。", 413)
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        image_path = None
        temp_name = None
        try:
            if image:
                assets.mkdir(mode=0o700, exist_ok=True)
                target = assets / (draft_id + ".image")
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                image_path = target
                with os.fdopen(fd, "wb") as stream:
                    stream.write(image[1])
                    stream.flush()
                    os.fsync(stream.fileno())
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory,
                                             prefix=".blueprints-", delete=False) as stream:
                temp_name = stream.name
                json.dump({"schema": 1, "drafts": drafts + [draft]}, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, STORE_FILE)
        except OSError as exc:
            if image_path is not None:
                image_path.unlink(missing_ok=True)
            raise BlueprintError("下書きを保存できませんでした。", 500) from exc
        finally:
            if temp_name is not None:
                Path(temp_name).unlink(missing_ok=True)
    return {"draft": draft, "notice": NOTICE}

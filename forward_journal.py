"""Creature Lab offline forecast journal, informed by V6 immutable-record patterns.

V6 reference (read-only): 13_株価予測/engine/forward_storage.py and
research/small_mvp/core.py. This is independently implemented, NOT a V6
model import, Official record, real-time scheduler, or live forecast.
Records are normal local files, not tamper-proof cryptographic evidence.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
from uuid import uuid4

from engine import multiclass_brier

CLASSES = ("UP", "FLAT", "DOWN")
MODE = "OFFLINE_REPLAY_ONLY"
SCHEMA = "creature-forward-journal-v1"
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")


class JournalError(ValueError):
    pass


def _date(value: str) -> str:
    if type(value) is not str or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise JournalError("日付はYYYY-MM-DDです")
    try:
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError()
    except ValueError:
        raise JournalError("実在しない日付です") from None
    return value


def _time(value: str) -> datetime:
    if type(value) is not str:
        raise JournalError("時刻が必要です")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise JournalError("時刻が不正です") from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise JournalError("時差つき時刻が必要です")
    return parsed


def _id(value: str) -> str:
    if type(value) is not str or not SAFE_ID.fullmatch(value) or value in (".", ".."):
        raise JournalError("識別子が不正です")
    return value


def _hash(value: str) -> str:
    if type(value) is not str or not SHA.fullmatch(value):
        raise JournalError("SHA256が不正です")
    return value


def _probabilities(values: dict) -> dict:
    if type(values) is not dict or set(values) != set(CLASSES):
        raise JournalError("3方向の確率が必要です")
    if any(type(values[k]) not in (float, int) or not math.isfinite(values[k])
           or not 0 <= values[k] <= 1 for k in CLASSES):
        raise JournalError("確率は0〜1の有限値です")
    if not math.isclose(sum(values.values()), 1.0, abs_tol=1e-9, rel_tol=0):
        raise JournalError("確率の合計は1です")
    return {k: float(values[k]) for k in CLASSES}


def _canonical(obj: dict) -> bytes:
    return (json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"),
                       allow_nan=False) + "\n").encode("utf-8")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@contextmanager
def _locked(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    if root.is_symlink():
        raise JournalError("シンボリックリンク先への保存は禁止です")
    fd = os.open(root / ".lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def _read(path: Path) -> dict:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as file:
        raw = file.read(128 * 1024 + 1)
    if len(raw) > 128 * 1024:
        raise JournalError("記録が大きすぎます")
    try:
        data = json.loads(raw)
        if set(data) != {"record", "sha256"} or data["sha256"] != _sha(_canonical(data["record"])):
            raise JournalError("記録の検証に失敗しました")
        if raw != _canonical(data):
            raise JournalError("保存形式が変更されています")
        return data
    except (ValueError, TypeError, KeyError) as e:
        raise JournalError("記録の検証に失敗しました") from e


def _create_only(path: Path, record: dict) -> str:
    """Exclusive atomic name publication, same-content retry no-op."""
    digest = _sha(_canonical(record))
    body = _canonical({"record": record, "sha256": digest})
    try:
        prior = _read(path)
    except FileNotFoundError:
        prior = None
    if prior is not None:
        if prior["record"] == record:
            return digest
        raise JournalError("確定済み記録は上書きできません")
    pending = path.parent / (".pending-" + uuid4().hex)
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(body)
            file.flush()
            os.fsync(file.fileno())
        if _read(pending)["sha256"] != digest:
            raise JournalError("保存内容の再検証に失敗しました")
        try:
            os.link(pending, path, follow_symlinks=False)
        except FileExistsError:
            raise JournalError("別の記録が先に保存されました") from None
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return digest
    finally:
        pending.unlink(missing_ok=True)


def _path(root: Path, run_id: str, target: str, kind: str) -> Path:
    return root / f"{_id(run_id)}--{_date(target)}.{kind}.json"


def freeze_offline(root: Path, *, run_id: str, as_of_session: str, target_session: str,
                   calendar: list[str], generated_at: str, input_available_at: str,
                   input_sha256: str, model_sha256: str, probabilities: dict) -> dict:
    """Store a reproducible offline/replay forecast. NOT forward performance."""
    _id(run_id)
    _date(as_of_session)
    _date(target_session)
    made, available = _time(generated_at), _time(input_available_at)
    if available > made:
        raise JournalError("予測後に利用可能になった入力は使えません")
    if (type(calendar) is not list or not calendar
            or any(_date(day) != day for day in calendar)
            or calendar != sorted(set(calendar))
            or as_of_session not in calendar
            or calendar.index(as_of_session) + 1 >= len(calendar)
            or calendar[calendar.index(as_of_session) + 1] != target_session):
        raise JournalError("予測対象は指定カレンダーの次の営業日です")
    record = {
        "schema": SCHEMA, "mode": MODE, "forward_eligible": False,
        "run_id": run_id, "as_of_session": as_of_session,
        "target_session": target_session,
        "generated_at": made.isoformat(), "input_available_at": available.isoformat(),
        "input_sha256": _hash(input_sha256),
        "model_sha256": _hash(model_sha256),
        "probabilities": _probabilities(probabilities),
        "notice": "架空・オフラインの時点別記録。本番の先行予測ではありません。"
    }
    root = Path(root)
    with _locked(root):
        digest = _create_only(_path(root, run_id, target_session, "forecast"), record)
    return {"record": record, "sha256": digest}


def settle_offline(root: Path, *, run_id: str, target_session: str,
                   actual: str, outcome_available_at: str, outcome_sha256: str) -> dict:
    """Attach immutable outcome after forecast exists. No XP, orders, or rewrite."""
    _id(run_id)
    _date(target_session)
    if actual not in CLASSES:
        raise JournalError("確定方向が不正です")
    available = _time(outcome_available_at)
    _hash(outcome_sha256)
    root = Path(root)
    with _locked(root):
        source = _read(_path(root, run_id, target_session, "forecast"))
        forecast = source["record"]
        if forecast.get("mode") != MODE or forecast.get("target_session") != target_session:
            raise JournalError("予測記録の種類が不正です")
        if available <= _time(forecast["generated_at"]):
            raise JournalError("予測が作られる前の採点はできません")
        value = multiclass_brier(actual, forecast["probabilities"])
        record = {
            "schema": SCHEMA, "mode": MODE, "forward_eligible": False,
            "run_id": run_id, "target_session": target_session,
            "forecast_sha256": source["sha256"], "actual": actual,
            "outcome_available_at": available.isoformat(),
            "outcome_sha256": outcome_sha256,
            "brier": round(value, 9),
            "uniform_brier": round(2 / 3, 9),
            "notice": "オフライン再生の評価。実市場の予測実績ではありません。"
        }
        digest = _create_only(_path(root, run_id, target_session, "outcome"), record)
    return {"record": record, "sha256": digest}

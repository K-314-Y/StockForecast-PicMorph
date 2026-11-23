"""Offline research replay of the two allowlisted private, adjusted archives."""
from contextlib import contextmanager
from datetime import date
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import re
import stat
import sys

if __package__:
    from .market_replay import HORIZON, LOOKBACK, parse_models, replay_window
else:
    from market_replay import HORIZON, LOOKBACK, parse_models, replay_window


ROOT = Path(__file__).resolve().parents[2] / "13_株価予測/local_results/v5_workspace/market_inputs"
ORIGIN = "LOCAL_PRIVATE_JQUANTS_ADJUSTED_RESEARCH"
SOURCE = "J-Quants V2 adjusted close (private local research archive)"
STATUS = "PARTIAL_485_OF_487_RESEARCH_ONLY_NOT_FORWARD"
FIRST = "2024-08-05"
CUTOFF = "2025-08-01"
LAST = "2026-07-31"
MISSING = ["2024-08-01", "2024-08-02"]
ROW_COUNT = 485
MAX_INPUT, MAX_OUTPUT, MAX_WINDOWS = 16 * 1024, 512 * 1024, 160
MAX_FILE = 1024 * 1024
MAX_MANIFEST = 128 * 1024
CODES = ("40050", "46890", "47550", "50200", "72010", "84100", "85930", "86040", "94320", "95010")
SHARDS = {
    "jquants_adjusted_94320_20261027_01": {"validated_rows.json": "94320"},
    "jquants_adjusted_remaining9_20261027_01": {f"{code}.json": code for code in CODES if code != "94320"},
}
FALSE_FLAGS = ("rights_verified", "license_verified", "pit_verified", "corporate_action_verified",
               "full_historical_coverage", "forward_eligible", "training_eligible", "actual_forward_eligible",
               "live_forward_eligible", "forecast_accuracy_established", "model_trained", "official_allowed",
               "production_certified", "trading_allowed")
READ_DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


@contextmanager
def directory(path):
    """Walk every path component without following symlinks."""
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("invalid archive root")
    fd = os.open("/", READ_DIRECTORY)
    try:
        for component in path.parts[1:]:
            next_fd = os.open(component, READ_DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd
    finally:
        os.close(fd)


def file_version(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def read_private(folder, name, limit):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=folder)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or
                info.st_uid != os.geteuid() or info.st_nlink != 1 or not 0 < info.st_size <= limit):
            raise ValueError("unsafe archive file")
        raw = stream.read(limit + 1)
        if (len(raw) != info.st_size or file_version(info) != file_version(os.fstat(fd)) or
                file_version(info) != file_version(os.stat(name, dir_fd=folder, follow_symlinks=False))):
            raise ValueError("archive changed while reading")
    return raw, file_version(info)


def decode_strict(raw):
    def unique(pairs):
        obj = dict(pairs)
        if len(obj) != len(pairs):
            raise ValueError("duplicate JSON key")
        return obj

    def reject_constant(_):
        raise ValueError("invalid JSON number")

    return json.loads(raw.decode("utf-8"), object_pairs_hook=unique, parse_constant=reject_constant)


def manifest_files(manifest, expected):
    if (not isinstance(manifest, dict) or manifest.get("status") != STATUS or
            manifest.get("usage") != "USER_OWN_PRIVATE_RESEARCH_ONLY" or
            manifest.get("source_api") != "https://api.jquants.com/v2/equities/bars/daily" or
            manifest.get("timestamp_basis") != "RETRIEVAL_NOT_POINT_IN_TIME" or
            manifest.get("corporate_action_status") != "UNVERIFIED" or manifest.get("missing_sessions") != MISSING or
            not all(manifest.get(key) is False for key in FALSE_FLAGS)):
        raise ValueError("unexpected archive provenance or permissions")
    params = {"from": FIRST, "to": LAST}
    if len(expected) == 1:
        params["code"] = "94320"
        counts = {"row_count": ROW_COUNT, "original_row_count": ROW_COUNT + len(MISSING)}
    else:
        if manifest.get("codes") != sorted(expected.values()):
            raise ValueError("unexpected code coverage")
        counts = {"row_count_per_code": ROW_COUNT, "original_row_count_per_code": ROW_COUNT + len(MISSING),
                  "total_row_count": ROW_COUNT * len(expected)}
    files = manifest.get("files")
    if (manifest.get("parameters") != params or not all(type(manifest.get(k)) is int and manifest[k] == v
            for k, v in counts.items()) or not isinstance(files, dict) or files.keys() != expected.keys() or
            not all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) for value in files.values())):
        raise ValueError("unexpected archive manifest")
    return files


def checked_rows(rows, code):
    if not isinstance(rows, list) or len(rows) != ROW_COUNT:
        raise ValueError("invalid session count")
    result, previous = [], ""
    for row in rows:
        if not isinstance(row, dict) or row.get("Code") != code:
            raise ValueError("unexpected row code")
        day, close, factor = row.get("Date"), row.get("AdjC"), row.get("AdjFactor")
        if (not isinstance(day, str) or not FIRST <= day <= LAST or day <= previous or
                date.fromisoformat(day).isoformat() != day or not all(type(value) in (int, float) and
                    math.isfinite(value) and value > 0 for value in (close, factor))):
            raise ValueError("invalid adjusted observation")
        result.append((day, float(close)))
        previous = day
    if result[0][0] != FIRST or result[-1][0] != LAST:
        raise ValueError("missing archive boundary")
    return result


def load_adjusted(root=ROOT):
    """Read and verify both shards. The optional root is for internal fixture tests."""
    series, calendar = {}, None
    with directory(root) as parent:
        for folder, expected in SHARDS.items():
            fd = os.open(folder, READ_DIRECTORY, dir_fd=parent)
            try:
                info = os.fstat(fd)
                if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
                    raise ValueError("unsafe private archive directory")
                manifest_raw, manifest_version = read_private(fd, "manifest.json", MAX_MANIFEST)
                files = manifest_files(decode_strict(manifest_raw), expected)
                versions = {"manifest.json": manifest_version}
                for name, code in expected.items():
                    raw, versions[name] = read_private(fd, name, MAX_FILE)
                    if sha256(raw).hexdigest() != files[name]:
                        raise ValueError("archive SHA mismatch")
                    series[code] = checked_rows(decode_strict(raw), code)
                    days = [day for day, _ in series[code]]
                    if calendar is not None and calendar != days:
                        raise ValueError("inconsistent session calendars")
                    calendar = days
                if (file_version(info) != file_version(os.stat(folder, dir_fd=parent, follow_symlinks=False)) or
                        any(version != file_version(os.stat(name, dir_fd=fd, follow_symlinks=False))
                            for name, version in versions.items())):
                    raise ValueError("archive replaced during validation")
            finally:
                os.close(fd)
    if sorted(series) != list(CODES):
        raise ValueError("unexpected final code set")
    return calendar, series


def select_windows(calendar):
    """Select positions using only session dates and the fixed cutoff."""
    split = next(index for index, day in enumerate(calendar) if day >= CUTOFF)
    phases = {}
    for name, start, end in (("early", 0, split), ("later", split, len(calendar))):
        windows = []
        while start + LOOKBACK + HORIZON <= end:
            stop = start + LOOKBACK + HORIZON
            gap = next((i for i in range(start + 1, stop) if
                        (date.fromisoformat(calendar[i]) - date.fromisoformat(calendar[i - 1])).days > 10), None)
            if gap is not None:
                start = gap
                continue
            windows.append((start, stop))
            start = stop
        if not windows:
            raise ValueError("incomplete phase")
        phases[name] = windows
    if sum(map(len, phases.values())) * len(CODES) > MAX_WINDOWS:
        raise ValueError("too many replay windows")
    return phases


def evaluate(data):
    if not isinstance(data, dict) or data.keys() != {"base_model", "models"}:
        raise ValueError("invalid adjusted replay input")
    base, models = parse_models(data["base_model"], data["models"])
    calendar, series = load_adjusted()
    selection = select_windows(calendar)
    source = {"origin": ORIGIN, "source": SOURCE, "adjusted": True,
              "warning": "取得時点の調整済み終値です。当時入手可能だった値か、企業行動の処理が正しいかは未確認です。"}
    phases = {}
    for phase, windows in selection.items():
        count = len(windows) * len(CODES)
        phases[phase] = []
        for code in CODES:
            for start, stop in windows:
                ident = "mkt_" + sha256(f"{phase}:{code}:{calendar[start]}:{calendar[stop - 1]}".encode()).hexdigest()[:24]
                report = replay_window(source, count, (ident, code, series[code][start:stop]), base, models)
                for slot, model in models.items():
                    report["plan"]["models"][slot].update(fast_window=model.fast_window, slow_window=model.slow_window)
                phases[phase].append(report)
    return {"schema": 1, "source_origin": ORIGIN, "adjusted": True, "archive_status": STATUS,
            "manifests_verified": True, "sessions_per_code": ROW_COUNT, "missing_sessions": MISSING,
            "flags": dict.fromkeys(FALSE_FLAGS, False), "split_date": CUTOFF, "calendar": calendar, "phases": phases}


def main(stdin, stdout):
    raw = stdin.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ValueError("input limit exceeded")
    response = json.dumps(evaluate(decode_strict(raw)), ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(response) > MAX_OUTPUT:
        raise ValueError("output limit exceeded")
    stdout.write(response)


if __name__ == "__main__":
    try:
        main(sys.stdin.buffer, sys.stdout.buffer)
    except (ValueError, KeyError, TypeError, OSError, OverflowError, StopIteration):
        print("private adjusted research archive unavailable", file=sys.stderr)
        sys.exit(1)

"""Read-only structure checks for one future-evaluation evidence package."""

from contextlib import ExitStack
from datetime import date, datetime, time, timezone
import json
import math
import os
import re
import stat
import sys

from accessory_registration_store import FOLDER, ID, JST, LIMIT, UTC_STAMP, canonical, check_record, shape
from character_parts import ROOT, PartsError, digest, directory, read_file
from independent_parts import matches, require
from independent_parts_catalog import file_version, json_object, private_directory, private_file, recheck


INPUT_FOLDER = "accessory_evaluation_inputs"
INPUT_LIMIT = 512 * 1024
# Canonical digest of the S104 V1 protocol. Validate frozen records even if the executable copy drifts.
PROTOCOL_V1_SHA = "365c8e6e85aa0f168738742ebd4d0a802ef5720ef0da80e22c26e63f56317777"
SOURCE_TYPE = "session_adjusted_close_evidence_v1"
REF = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}")
EVIDENCE = {"source", "retrieval", "calendar", "adjustment", "rights", "point_in_time"}
UNAVAILABLE = (OSError, PartsError, ValueError, TypeError, KeyError, OverflowError, RecursionError)


class RecordNotFound(PartsError):
    pass


class InvalidInput(ValueError):
    pass


def demand(condition, reason):
    if not condition:
        raise InvalidInput(reason)


def calendar_day(value):
    try:
        day = date.fromisoformat(value)
    except (ValueError, TypeError):
        raise InvalidInput("calendar_structure") from None
    demand(day.isoformat() == value, "calendar_structure")
    return day


def utc_timestamp(value):
    demand(matches(UTC_STAMP, value), "timestamp_structure")
    try:
        return datetime.fromisoformat(value[:-1]+"+00:00")
    except ValueError:
        raise InvalidInput("timestamp_structure") from None


def expected_counts(record):
    protocol = record["protocol"]
    codes = len(protocol["codes"])
    history = protocol["lookback_sessions"]
    evaluation = protocol["evaluation_sessions_per_code"]
    return {"codes": codes, "history_sessions": history, "evaluation_sessions": evaluation,
            "rows": codes * (history + evaluation)}


def validate_package(data, record, registration_id, now):
    """Demand exact V1 structure. Claims and digests are never authenticated here."""
    demand(shape(data, {"schema", "registration_id", "source", "evidence", "calendar", "rows"}) and
           type(data["schema"]) is int and data["schema"] == 1, "manifest_shape")
    demand(data["registration_id"] == registration_id, "registration_binding")
    source = data["source"]
    evidence = data["evidence"]
    demand(shape(source, {"type", "id", "retrieved_at"}) and source["type"] == SOURCE_TYPE and
           matches(REF, source["id"]) and shape(evidence, EVIDENCE) and
           all(shape(item, {"ref", "sha256"}) and matches(REF, item["ref"]) and matches(ID, item["sha256"])
               for item in evidence.values()), "source_evidence")
    retrieved = utc_timestamp(source["retrieved_at"])
    demand(retrieved <= now, "timestamp_structure")

    counts = expected_counts(record)
    history, evaluation = counts["history_sessions"], counts["evaluation_sessions"]
    calendar = data["calendar"]
    demand(shape(calendar, {"coverage_start", "coverage_end", "registration_jst_day", "sessions"}) and
           calendar["registration_jst_day"] == record["registered_jst_day"] and
           isinstance(calendar["sessions"], list) and len(calendar["sessions"]) == history + evaluation,
           "calendar_structure")
    days, closes = [], []
    for session in calendar["sessions"]:
        demand(shape(session, {"date", "close_at"}), "calendar_structure")
        day = calendar_day(session["date"])
        demand(day.weekday() < 5 and (not days or days[-1] < day), "calendar_structure")
        close = utc_timestamp(session["close_at"]).astimezone(JST)
        # This conservative V1 floor does not establish the official exchange close or holiday calendar.
        demand(close.date() == day and close.time() >= time(15, 30) and close <= retrieved, "timestamp_structure")
        days.append(day)
        closes.append(close)
    names = [day.isoformat() for day in days]
    demand(calendar["coverage_start"] == names[0] and calendar["coverage_end"] == names[-1] and
           names[history-1] <= record["registered_jst_day"] < names[history], "calendar_structure")

    rows = data["rows"]
    demand(shape(rows, set(record["protocol"]["codes"])), "row_alignment")
    for series in rows.values():
        demand(isinstance(series, list) and len(series) == len(days), "row_alignment")
        for row, day, close in zip(series, names, closes):
            demand(shape(row, {"date", "adjusted_close", "available_at", "observed_at"}) and
                   row["date"] == day, "row_alignment")
            price = row["adjusted_close"]
            demand(type(price) in (int, float) and 0 < price < math.inf, "row_alignment")
            available = utc_timestamp(row["available_at"])
            observed = utc_timestamp(row["observed_at"])
            demand(close <= available <= observed <= retrieved, "timestamp_structure")
    return {**counts, "history_first": names[0], "history_last": names[history-1],
            "evaluation_first": names[history], "evaluation_last": names[-1]}


def fingerprints_match(root, record):
    """Return False only for a computed hash mismatch; unreadable sources fail closed."""
    sources = []
    matches_frozen = True
    with directory("game_runtime", root) as runtime:
        runtime_info = os.fstat(runtime)
        for name, expected in record["source_sha256"].items():
            parent = runtime if name.startswith("game_runtime/") else root
            fname = name.rsplit("/", 1)[-1]
            before = os.stat(fname, dir_fd=parent, follow_symlinks=False)
            require(stat.S_ISREG(before.st_mode), "Unsafe executable source.")
            actual = digest(read_file(parent, fname, 256 * 1024))
            sources.append((parent, fname, file_version(before)))
            if actual != expected:
                matches_frozen = False
        recheck([(root, "game_runtime", runtime_info)], sources)
    return matches_frozen


def report(record, status, reason, actual=None):
    return {"status": status, "reason": reason, "expected": expected_counts(record), "actual": actual,
            "registered_jst_day": record["registered_jst_day"], "earliest_possible_day": record["earliest_possible_day"],
            "score_allowed": False, "holdout_evaluated": False, "calendar_verified": False,
            "source_verified": False, "rights_verified": False, "point_in_time_verified": False,
            "adjustments_verified": False, "timestamps_verified": False}


def inspect(registration_id, *, root=ROOT, now=None):
    require(sys.platform == "linux" and matches(ID, registration_id), "Invalid registration ID.")
    filename = registration_id + ".json"
    paths, snapshots = [], []
    with ExitStack() as opened:
        repo = opened.enter_context(directory(root))
        try:
            state = opened.enter_context(private_directory(repo, "local_state", paths, state=True))
            registrations = opened.enter_context(private_directory(state, FOLDER, paths))
            raw = private_file(registrations, filename, LIMIT, snapshots)
        except FileNotFoundError as error:
            raise RecordNotFound() from error
        protocol = json_object(raw).get("protocol")
        require(digest(canonical(protocol)) == PROTOCOL_V1_SHA, "Invalid frozen V1 protocol.")
        record, _ = check_record(raw, filename, protocol)

        try:
            inputs = opened.enter_context(private_directory(state, INPUT_FOLDER, paths))
            package = private_file(inputs, filename, INPUT_LIMIT, snapshots)
        except FileNotFoundError:
            result = report(record, "pending_input", "input_missing")
        except UNAVAILABLE:
            result = report(record, "pending_invalid_input", "unsafe_input")
        else:
            if not fingerprints_match(repo, record):
                result = report(record, "pending_code_mismatch", "code_mismatch")
            else:
                try:
                    data = json_object(package.decode("utf-8"))
                    actual = validate_package(data, record, registration_id, now or datetime.now(timezone.utc))
                    result = report(record, "pending_evidence_review", "evidence_unreviewed", actual)
                except InvalidInput as error:
                    result = report(record, "pending_invalid_input", str(error))
                except UNAVAILABLE:
                    result = report(record, "pending_invalid_input", "manifest_shape")
        recheck(paths, snapshots)
        return result


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(4097)
        require(len(raw) <= 4096 and len(sys.argv) == 1, "Invalid check request.")
        request = json_object(raw)
        require(shape(request, {"registration_id"}), "Invalid check request.")
        print(json.dumps({"result": inspect(request["registration_id"])}))
    except RecordNotFound:
        print('{"code":"not_found"}')
    except UNAVAILABLE:
        print('{"code":"unavailable"}')

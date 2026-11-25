"""Private append-only accessory experiment records for the local Linux game."""

from contextlib import ExitStack
from datetime import date, datetime, timedelta, timezone
import fcntl
from itertools import islice
import json
import math
import os
import re
import sys

from accessory_analysis_store import FOCI, validate_policies
from character_equipment import valid_revision
from character_parts import ROOT, PartsError, digest, directory, move_exclusive, remove_temporary_file
from independent_parts import KIND, matches, require
from independent_parts_catalog import json_object, private_directory, private_file, recheck


FOLDER = "accessory_registrations"
STAGING = ".registration-staging"
LIMIT = 8192
CAPACITY = 50
ID = re.compile(r"[a-f0-9]{64}")
FILENAME = re.compile(r"[a-f0-9]{64}\.json")
CHARACTER = re.compile(r"cp_[a-f0-9]{32}")
UTC_STAMP = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z")
JST = timezone(timedelta(hours=9))
CONTENT = {"schema", "registered_jst_day", "earliest_possible_day", "context", "source_revisions",
           "base_model", "baseline", "candidate", "applied_rules", "visible_kinds", "source_sha256",
           "protocol", "timestamp_basis", "status"}
CONTEXT = {"character_id", "active_revision", "equipment_revision", "expected_revision"}
REVISIONS = {"source_revision", "lineup_revision", "growth_revision", "companion_revision"}
MODELS = {"fast_window", "slow_window", "risk_fraction", "plugin_weights", "plugin_strengths"}


class Rejected(PartsError):
    pass


def canonical(value):
    """V1 canonical bytes are sorted compact ASCII JSON with no trailing newline."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii")


def shape(obj, keys):
    return isinstance(obj, dict) and obj.keys() == keys


def check_model(model):
    require(shape(model, MODELS), "Invalid frozen model fields.")
    fast, slow, risk = (model[k] for k in ("fast_window", "slow_window", "risk_fraction"))
    require(type(fast) is type(slow) is int and 2 <= fast < slow <= 20 and
            type(risk) in (int, float) and math.isfinite(risk) and .05 <= risk <= 1, "Invalid frozen model parameters.")
    for key, low, high in (("plugin_weights", 0, 100), ("plugin_strengths", 50, 150)):
        require(shape(model[key], set(FOCI)) and all(type(v) is int and low <= v <= high for v in model[key].values()),
                "Invalid frozen model indicators.")
    require(sum(model["plugin_weights"].values()) == 100, "Invalid frozen weight sum.")


def check_content(content, protocol):
    require(shape(content, CONTENT) and type(content["schema"]) is int and content["schema"] == 1 and
            content["status"] == "pending_no_verified_data" and content["timestamp_basis"] == "local_system_clock" and
            canonical(content["protocol"]) == canonical(protocol), "Invalid registration schema or protocol.")
    day = date.fromisoformat(content["registered_jst_day"])
    require(day.isoformat() == content["registered_jst_day"] and
            (day + timedelta(days=1)).isoformat() == content["earliest_possible_day"], "Invalid registration day.")
    ctx = content["context"]
    require(shape(ctx, CONTEXT) and matches(CHARACTER, ctx["character_id"]) and
            all(valid_revision(ctx[k]) for k in CONTEXT - {"character_id"}), "Invalid registered context.")
    revisions = content["source_revisions"]
    require(shape(revisions, REVISIONS) and all(valid_revision(v) for v in revisions.values()), "Invalid source revisions.")
    hashes = content["source_sha256"]
    require(shape(hashes, set(protocol["source_files"])) and all(matches(ID, h) for h in hashes.values()),
            "Invalid executable fingerprints.")
    for key in ("base_model", "baseline", "candidate"):
        check_model(content[key])
    require(all(content["baseline"][key] == content["candidate"][key] for key in MODELS - {"plugin_weights"}),
            "Candidate has unexpected differences from baseline.")
    visible, rules = content["visible_kinds"], content["applied_rules"]
    require(isinstance(visible, list) and 1 <= len(visible) <= 8 and all(matches(KIND, v) and len(v) <= 64 for v in visible)
            and visible == sorted(set(visible)), "Invalid visible kinds.")
    require(rules and rules == validate_policies(rules) and all(row["kind_id"] in visible for row in rules),
            "Invalid applied rules.")


def check_record(raw, name, protocol):
    record = json_object(raw)
    require(shape(record, CONTENT | {"created_at"}) and canonical(record) == raw and name == digest(raw) + ".json",
            "Invalid canonical record or content hash.")
    content = {key: record[key] for key in CONTENT}
    check_content(content, protocol)
    created = record["created_at"]
    require(matches(UTC_STAMP, created) and datetime.fromisoformat(created[:-1]+"+00:00").astimezone(JST).date().isoformat() ==
            record["registered_jst_day"], "Invalid creation timestamp.")
    return record, digest(canonical(content))


def metadata(record, identifier):
    return {"id": identifier, **{key: record[key] for key in
            ("created_at", "registered_jst_day", "earliest_possible_day", "status", "timestamp_basis")}}


def saved_records(folder, protocol, snapshots, *, saving):
    with os.scandir(folder) as entries:
        names = [entry.name for entry in islice(entries, CAPACITY + 2)]
    files = [name for name in names if name != STAGING]
    require(len(files) <= CAPACITY and all(matches(FILENAME, name) for name in files), "Invalid registration records.")
    # A failed publish may leave this reserved file. Read it only to validate its identity on list.
    if STAGING in names and not saving:
        private_file(folder, STAGING, LIMIT, snapshots)
    records, identities = [], set()
    for name in files:
        record, identity = check_record(private_file(folder, name, LIMIT, snapshots), name, protocol)
        require(identity not in identities, "Duplicate fixed content.")
        identities.add(identity)
        records.append(metadata(record, name[:-5]))
    return records, identities


def utc_now():
    return datetime.now(timezone.utc)


def check_time(content, expires_at_ms):
    now = utc_now()
    millis = int(now.timestamp() * 1000)
    if now.astimezone(JST).date().isoformat() != content["registered_jst_day"] or not millis < expires_at_ms <= millis + 300000:
        raise Rejected("stale")
    return now


def publish(folder, name, raw, paths, snapshots, content, expires_at_ms):
    require(0 < len(raw) <= LIMIT, "Registration record too large.")
    remove_temporary_file(folder, STAGING)
    fd = os.open(STAGING, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        require(private_file(folder, STAGING, LIMIT, snapshots) == raw, "Registration staging changed.")
        recheck(paths, snapshots)
        check_time(content, expires_at_ms)
        try:
            move_exclusive(folder, STAGING, name)
        except FileExistsError as exc:
            raise Rejected("duplicate") from exc
        os.fsync(folder)
    finally:
        remove_temporary_file(folder, STAGING)


def run(operation, args):
    require(sys.platform == "linux" and operation in ("list", "save"), "Invalid registration store operation.")
    saving = operation == "save"
    require(shape(args, {"content", "expires_at_ms"} if saving else set()), "Invalid store request.")
    protocol = json_object((ROOT / "game_runtime/accessory-registration-protocol-v1.json").read_bytes())
    if saving:
        content, expires_at_ms = args["content"], args["expires_at_ms"]
        check_content(content, protocol)
        require(valid_revision(expires_at_ms), "Invalid expiration.")
        check_time(content, expires_at_ms)
    paths, snapshots = [], []
    with ExitStack() as opened:
        root = opened.enter_context(directory(ROOT))
        try:
            state = opened.enter_context(private_directory(root, "local_state", paths, create=saving, state=True))
            folder = opened.enter_context(private_directory(state, FOLDER, paths, create=saving))
        except FileNotFoundError:
            if not saving:
                return {"registrations": []}
            raise
        fcntl.flock(folder, fcntl.LOCK_EX if saving else fcntl.LOCK_SH)
        records, identities = saved_records(folder, protocol, snapshots, saving=saving)
        recheck(paths, snapshots)
        if not saving:
            return {"registrations": sorted(records, key=lambda row: (row["created_at"], row["id"]), reverse=True)}
        if digest(canonical(content)) in identities:
            raise Rejected("duplicate")
        if len(records) >= CAPACITY:
            raise Rejected("full")
        now = check_time(content, expires_at_ms)
        record = {**content, "created_at": now.isoformat(timespec="milliseconds").replace("+00:00", "Z")}
        raw = canonical(record)
        identifier = digest(raw)
        publish(folder, identifier + ".json", raw, paths, snapshots, content, expires_at_ms)
        return {"registration": metadata(record, identifier)}


if __name__ == "__main__":
    try:
        os.umask(0o077)
        raw = sys.stdin.buffer.read(LIMIT + 1)
        require(len(sys.argv) == 2 and len(raw) <= LIMIT, "Registration request too large.")
        print(json.dumps({"result": run(sys.argv[1], json_object(raw))}))
    except Rejected as error:
        print(json.dumps({"code": str(error)}))
    except (PartsError, OSError, ValueError, TypeError, KeyError, OverflowError, RecursionError):
        print(json.dumps({"code": "unavailable"}))

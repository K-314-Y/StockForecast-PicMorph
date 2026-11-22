"""Linux JSON storage for per-character equipment, behind the local game API."""

from contextlib import ExitStack
import fcntl
from itertools import islice
import json
import os
import re
import sys

from character_parts import ROOT, PartsError, directory, json_bytes, move_exclusive, remove_temporary_file
from independent_parts import ID, LAYER_ANCHORS, SHA256, matches, require
from independent_parts_catalog import json_object, private_directory, private_file, recheck


STORE = "character_equipment"
STAGING = ".equipment-staging"
FILENAME = re.compile(r"cp_[0-9a-f]{32}\.json")
MAX_RECORDS = 32
MAX_BYTES = 4096
MAX_REVISION = 2**53 - 1


class Conflict(PartsError):
    pass


def valid_revision(value):
    return type(value) is int and 0 <= value <= MAX_REVISION


def validate_parts(parts):
    require(isinstance(parts, list) and len(parts) <= 8, "Invalid equipment part count.")
    seen = set()
    for part in parts:
        require(isinstance(part, dict) and set(part) == {
            "part_id", "layer_anchor", "x", "y", "visible", "image_sha256",
        }, "Invalid equipment fields.")
        identifier = part["part_id"]
        require(matches(ID["pt"], identifier) and identifier not in seen and
                matches(SHA256, part["image_sha256"]) and part["layer_anchor"] in LAYER_ANCHORS and
                type(part["visible"]) is bool and
                all(type(part[axis]) is int and -24 <= part[axis] <= 24 for axis in ("x", "y")),
                "Invalid equipment part.")
        seen.add(identifier)


def read_record(folder, name, character_id, snapshots):
    try:
        data = private_file(folder, name, MAX_BYTES, snapshots)
    except FileNotFoundError:
        return {"schema": 1, "character_id": character_id, "revision": 0, "parts": []}
    record = json_object(data)
    require(set(record) == {"schema", "character_id", "revision", "parts"} and
            type(record["schema"]) is int and record["schema"] == 1 and record["character_id"] == character_id and
            valid_revision(record["revision"]) and record["revision"] > 0, "Invalid equipment record.")
    validate_parts(record["parts"])
    return record


def check_capacity(folder, existing):
    with os.scandir(folder) as entries:
        names = [entry.name for entry in islice(entries, MAX_RECORDS + 1)]
    require(len(names) <= MAX_RECORDS and all(matches(FILENAME, name) for name in names),
            "Invalid equipment storage entries.")
    require(existing or len(names) < MAX_RECORDS, "Character equipment storage is full.")


def write_record(folder, name, record, paths, snapshots):
    data = json_bytes(record)
    require(len(data) <= MAX_BYTES, "Equipment record is too large.")
    fd = os.open(STAGING, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        existing = bool(snapshots)
        require(private_file(folder, STAGING, MAX_BYTES, snapshots) == data, "Equipment staging changed.")
        recheck(paths, snapshots)
        if existing:
            os.replace(STAGING, name, src_dir_fd=folder, dst_dir_fd=folder)
        else:
            try:
                move_exclusive(folder, STAGING, name)
            except FileExistsError as exc:
                raise Conflict() from exc
        os.fsync(folder)
    finally:
        remove_temporary_file(folder, STAGING)


def run(operation, args):
    require(sys.platform == "linux" and operation in ("read", "save"), "Equipment storage requires Linux.")
    save = operation == "save"
    fields = {"character_id", "expected_revision", "parts"} if save else {"character_id"}
    require(set(args) == fields and matches(ID["cp"], args["character_id"]), "Invalid equipment character ID.")
    character_id = args["character_id"]
    if save:
        require(valid_revision(args["expected_revision"]), "Invalid equipment revision.")
        validate_parts(args["parts"])

    paths, snapshots = [], []
    with ExitStack() as opened:
        root = opened.enter_context(directory(ROOT))
        try:
            state = opened.enter_context(private_directory(root, "local_state", paths, state=True))
            folder = opened.enter_context(private_directory(state, STORE, paths, create=save))
        except FileNotFoundError:
            if not save:
                return {"schema": 1, "character_id": character_id, "revision": 0, "parts": []}
            raise
        # All helper processes serialize revisions through the private directory inode.
        # The calling subprocess has a fixed wall-clock deadline.
        fcntl.flock(folder, fcntl.LOCK_EX if save else fcntl.LOCK_SH)
        name = character_id + ".json"
        record = read_record(folder, name, character_id, snapshots)
        recheck(paths, snapshots)
        if not save:
            return record
        if record["revision"] != args["expected_revision"] or record["revision"] == MAX_REVISION:
            raise Conflict()
        remove_temporary_file(folder, STAGING)
        check_capacity(folder, bool(snapshots))
        result = {**record, "revision": record["revision"] + 1, "parts": args["parts"]}
        write_record(folder, name, result, paths, snapshots)
        return result


def main():
    os.umask(0o077)
    raw = sys.stdin.buffer.readline(MAX_BYTES + 1)
    require(len(sys.argv) == 2 and raw.endswith(b"\n") and len(raw) <= MAX_BYTES and
            not sys.stdin.buffer.read(1), "Expected one bounded JSON input line.")
    return run(sys.argv[1], json_object(raw))


if __name__ == "__main__":
    try:
        print(json.dumps({"result": main()}))
    except Conflict:
        print(json.dumps({"code": "conflict"}))
    except (PartsError, OSError, RecursionError, TypeError, ValueError):
        print(json.dumps({"code": "unavailable"}))

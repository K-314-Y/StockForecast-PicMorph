"""Private Linux store for explicitly saved analysis rules. No model writes."""

from contextlib import ExitStack
import fcntl
import json
import os
import sys

from character_equipment import Conflict, valid_revision, write_record
from character_parts import ROOT, PartsError, directory, remove_temporary_file
from independent_parts import KIND, matches, require
from independent_parts_catalog import json_object, private_directory, private_file, recheck


LIMIT = 8192
STAGING = ".analysis-staging"
NAME = "analysis.json"
FOCI = ("trend", "momentum", "reversion", "volatility")


def validate_policies(policies):
    require(isinstance(policies, list) and len(policies) <= 32, "Invalid rule count.")
    seen = set()
    for rule in policies:
        require(isinstance(rule, dict) and set(rule) == {"kind_id", "focus", "intensity"} and
                matches(KIND, rule["kind_id"]) and len(rule["kind_id"]) <= 64 and rule["kind_id"] not in seen and
                rule["focus"] in FOCI and type(rule["intensity"]) is int and 1 <= rule["intensity"] <= 3,
                "Invalid analysis rule.")
        seen.add(rule["kind_id"])
    return sorted(policies, key=lambda row: row["kind_id"])


def run(operation, input):
    require(sys.platform == "linux" and operation in ("read", "save"), "Invalid store operation.")
    save = operation == "save"
    require(set(input) == ({"expected_revision", "policies"} if save else set()), "Invalid store arguments.")
    if save:
        require(valid_revision(input["expected_revision"]), "Invalid revision.")
        policies = validate_policies(input["policies"])
    empty = {"schema": 1, "revision": 0, "policies": []}
    paths, snapshots = [], []
    with ExitStack() as opened:
        root = opened.enter_context(directory(ROOT))
        try:
            state = opened.enter_context(private_directory(root, "local_state", paths, state=True))
            folder = opened.enter_context(private_directory(state, "accessory_analysis", paths, create=save))
        except FileNotFoundError:
            if not save:
                return empty
            raise
        fcntl.flock(folder, fcntl.LOCK_EX if save else fcntl.LOCK_SH)
        try:
            data = private_file(folder, NAME, LIMIT, snapshots)
        except FileNotFoundError:
            current = empty
        else:
            current = json_object(data)
            require(set(current) == set(empty) and type(current["schema"]) is int and current["schema"] == 1 and
                    valid_revision(current["revision"]) and current["revision"] > 0, "Invalid analysis record.")
            current["policies"] = validate_policies(current["policies"])
        recheck(paths, snapshots)
        if not save:
            return current
        revision = current["revision"] + 1
        if current["revision"] != input["expected_revision"] or not valid_revision(revision):
            raise Conflict()
        remove_temporary_file(folder, STAGING)
        result = {"schema": 1, "revision": revision, "policies": policies}
        write_record(folder, NAME, result, paths, snapshots, max_bytes=LIMIT, staging=STAGING)
        return result


if __name__ == "__main__":
    try:
        os.umask(0o077)
        raw = sys.stdin.buffer.readline(LIMIT + 1)
        require(len(sys.argv) == 2 and len(raw) <= LIMIT and raw.endswith(b"\n") and
                not sys.stdin.buffer.read(1), "Expected bounded JSON.")
        print(json.dumps({"result": run(sys.argv[1], json_object(raw))}))
    except Conflict:
        print(json.dumps({"code": "conflict"}))
    except (PartsError, OSError, TypeError, ValueError, RecursionError):
        print(json.dumps({"code": "unavailable"}))

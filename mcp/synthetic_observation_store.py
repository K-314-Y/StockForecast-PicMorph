"""S112: local, synthetic-only observation-version storage prototype.

No real-data input, network, live clock claims, default storage path, CLI or game API.
Use the built-in scenarios and an isolated private directory in tests.
"""
from contextlib import contextmanager
from datetime import date, timedelta
import os
import secrets
import stat
import sys

from accessory_registration_store import canonical, ID, JST
from accessory_evaluation_readiness import utc_timestamp
from character_parts import digest, directory, move_exclusive, remove_temporary_file
from independent_parts import matches, require
from independent_parts_catalog import private_directory, private_file, recheck, json_object

FOLDER = "synthetic_observation_snapshots"
LIMIT = 64 * 1024
CODES = ("40050", "46890", "47550", "50200", "72010",
         "84100", "85930", "86040", "94320", "95010")
MODE = "SYNTHETIC_OBSERVATION_DRAFT_V2"
SCENARIOS = {
    "original": "2025-02-04T08:00:00.000Z",
    "corrected": "2025-02-04T23:00:00.000Z",
    "late": "2025-02-05T00:01:00.000Z",
}
OPEN_AT = "2025-02-05T00:00:00.000Z"  # fictional next session, 09:00 JST


def synthetic_snapshot(variant):
    require(type(variant) is str and variant in SCENARIOS, "Unknown synthetic observation.")
    decision_day = date(2025, 2, 5)
    dates = [decision_day - timedelta(days=i) for i in range(50, 0, -1)]
    # Fictional weekdays, not the official Japanese exchange calendar.
    days = [d.isoformat() for d in dates if d.weekday() < 5][-24:]
    rows = {code: [{"date": day, "close_cents": 10000 + index*101 + step*17}
                   for step, day in enumerate(days)] for index, code in enumerate(CODES)}
    if variant != "original":
        # A later capture contains a changed earlier value. It is a different version.
        rows[CODES[0]][-3]["close_cents"] += 37 if variant == "corrected" else 63
    return {"schema": 1, "mode": MODE, "scenario": variant,
            "decision_jst_day": decision_day.isoformat(), "opening_at": OPEN_AT,
            "observed_at": SCENARIOS[variant], "timestamp_basis": "synthetic_fixture_clock",
            "real_market_history": False, "source_verified": False, "score_allowed": False,
            "holdout_evaluated": False, "history_sessions": days, "rows": rows,
            "source_payload_sha256": digest(canonical(rows))}


def check_snapshot(raw, identifier):
    require(matches(ID, identifier) and digest(raw) == identifier, "Snapshot hash mismatch.")
    record = json_object(raw)
    # Exact canonical bytes and exact built-in synthetic fixture, never caller-supplied prices.
    require(canonical(synthetic_snapshot(record.get("scenario"))) == raw,
            "Invalid synthetic snapshot.")
    return record


@contextmanager
def snapshot_folder(root, *, create=False):
    require(sys.platform == "linux", "Linux-only synthetic prototype.")
    with directory(root) as parent:
        info = os.fstat(parent)
        require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700,
                "A private 0700 test root is required.")
        paths = []
        with private_directory(parent, FOLDER, paths, create=create) as folder:
            yield folder, paths


def save_synthetic_snapshot(root, variant):
    """Save one built-in version by content hash. Never replace a published file."""
    raw = canonical(synthetic_snapshot(variant))
    identifier = digest(raw)
    require(0 < len(raw) <= LIMIT, "Snapshot exceeds limit.")
    name = identifier + ".json"
    with snapshot_folder(root, create=True) as (folder, paths):
        snapshots = []
        try:
            existing = private_file(folder, name, LIMIT, snapshots)
        except FileNotFoundError:
            pass
        else:
            check_snapshot(existing, identifier)
            recheck(paths, snapshots)
            return identifier
        # Exclusive per-write staging and atomic non-replacing publication.
        stage = ".stage-" + secrets.token_hex(16)
        fd = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=folder)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            require(private_file(folder, stage, LIMIT, snapshots) == raw, "Staging mismatch.")
            recheck(paths, snapshots)
            try:
                move_exclusive(folder, stage, name)
            except FileExistsError:
                # A concurrent writer can publish the identical version first.
                checked = []
                check_snapshot(private_file(folder, name, LIMIT, checked), identifier)
                recheck(paths, checked)
            os.fsync(folder)
        finally:
            remove_temporary_file(folder, stage)
    return identifier


def load_snapshot(root, identifier):
    """Read only an explicitly pinned ID, never resolve a path or choose the latest."""
    require(matches(ID, identifier), "Invalid snapshot ID.")
    with snapshot_folder(root) as (folder, paths):
        snapshots = []
        raw = private_file(folder, identifier + ".json", LIMIT, snapshots)
        record = check_snapshot(raw, identifier)
        recheck(paths, snapshots)
        return record


def load_for_decision(root, identifier, decision_at):
    """A simulated decision can use a named snapshot only if observed before it.

    This checks fictional timestamps, not a trusted observation/decision clock.
    No fallback to another version when a snapshot is missing or late.
    """
    decision = utc_timestamp(decision_at)
    record = load_snapshot(root, identifier)
    observed = utc_timestamp(record["observed_at"])
    opening = utc_timestamp(record["opening_at"])
    require(observed <= decision < opening, "Snapshot unavailable before simulated opening.")
    require(decision.astimezone(JST).date().isoformat() in
            (record["history_sessions"][-1], record["decision_jst_day"]),
            "Invalid simulated decision day.")
    return record

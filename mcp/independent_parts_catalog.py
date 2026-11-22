"""Private Linux catalog for saved cutouts. The CLI accepts bounded JSON on stdin."""

from contextlib import ExitStack, contextmanager
import base64
import fcntl
from itertools import islice
import json
import os
import stat
import sys

from character_parts import (
    ENGINE, MODEL, PROVENANCE, ROOT, PARTS, PartsError, asset_info, directory,
    json_bytes, move_exclusive, publish, remove_temporary_file,
)
from import_png_character import ENGINE as USER_ENGINE, MODEL as USER_MODEL, PROVENANCE as USER_PROVENANCE
from independent_parts import (
    ATLAS_SIZE, FRAMES, HEIGHT, ID, MAX_ATLAS_BYTES, MAX_CANDIDATE_BYTES, PartValidationError, SHA256, WIDTH,
    matches, prepare_catalog_part, require, sha256, validate_catalog_part, validate_placement,
    validate_rights, validate_source, verified_png,
)


CATALOG = "independent_parts"
STAGING = ".staging-independent-part"
FILES = ("part.png", "manifest.json")
MAX_MANIFEST = 4096
MAX_REQUEST = 4096
MAX_PARTS = 32
SOURCE_LAYOUT = {"frames": FRAMES, "columns": FRAMES, "rows": 1,
                 "cell_width": WIDTH, "cell_height": HEIGHT}


class PartNotFound(PartsError):
    pass


@contextmanager
def private_directory(parent, name, paths, *, create=False, state=False):
    with directory(name, parent, create=create) as folder:
        info = os.fstat(folder)
        # Existing local_state may be group-writable. Every child we use is private.
        safe_mode = not info.st_mode & stat.S_IWOTH if state else stat.S_IMODE(info.st_mode) == 0o700
        require(info.st_uid == os.geteuid() and safe_mode, "Unsafe local catalog directory.")
        paths.append((parent, name, info))
        yield folder


def lock(folder, mode):
    try:
        fcntl.flock(folder, mode | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        raise PartsError("Local part storage is busy. Try again.") from exc


def file_version(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mode, info.st_uid,
            info.st_nlink, info.st_mtime_ns, info.st_ctime_ns)


def private_file(parent, name, limit, snapshots):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600 and
                info.st_uid == os.geteuid() and info.st_nlink == 1 and 0 < info.st_size <= limit,
                "Unsafe or oversized local part file.")
        data = stream.read(limit + 1)
        version = file_version(info)
        require(len(data) == info.st_size and file_version(os.fstat(stream.fileno())) == version,
                "Local part file changed while reading.")
        snapshots.append((parent, name, version))
        return data


def json_object(data):
    def unique_pairs(pairs):
        value = dict(pairs)
        require(len(value) == len(pairs), "Duplicate JSON keys are invalid.")
        return value

    value = json.loads(data, object_pairs_hook=unique_pairs)
    require(isinstance(value, dict), "Expected a JSON object.")
    return value


def read_manifest(folder, snapshots, name="manifest.json"):
    return json_object(private_file(folder, name, MAX_MANIFEST, snapshots))


def recheck(paths, snapshots):
    for parent, name, info in paths:
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        require(os.path.samestat(current, info) and current.st_mode == info.st_mode and
                current.st_uid == info.st_uid, "A local catalog directory moved or changed.")
    for parent, name, version in snapshots:
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        require(file_version(current) == version, "A local part file moved or changed.")


def read_source(folder, source, snapshots):
    manifest = read_manifest(folder, snapshots)
    demo = read_manifest(folder, snapshots, "demo.json")
    engine = demo.get("engine")
    models = {ENGINE: (MODEL, PROVENANCE), USER_ENGINE: (USER_MODEL, USER_PROVENANCE)}
    require(isinstance(engine, str) and engine in models, "Invalid registered source character.")
    model, provenance = models[engine]
    require(demo.get("visibility") == "local_only" and demo.get("browser_auto_link") is False and
            demo.get("generated_id") == source["source_id"] == manifest.get("generated_id") and
            type(manifest.get("schema_version")) is int and manifest["schema_version"] == 1 and
            manifest.get("engine") == engine and demo.get("model") == manifest.get("model") == model and
            manifest.get("source_provenance") == provenance and manifest.get("layout") == SOURCE_LAYOUT and
            isinstance(demo.get("name"), str) and demo["name"] == manifest.get("name"),
            "Invalid registered source character.")
    filename = PARTS[source["source_part"]]
    original = private_file(folder, filename, MAX_CANDIDATE_BYTES, snapshots)
    files = manifest.get("files")
    require(isinstance(files, dict) and files.get(filename) == asset_info(original, *ATLAS_SIZE),
            "Registered source PNG failed its manifest check.")
    return verified_png(original, source["source_sha256"], ATLAS_SIZE, MAX_CANDIDATE_BYTES)


def metadata(manifest):
    return {"part_id": manifest["part_id"], "kind_id": manifest["kind_id"],
            "layer_anchor": manifest["layer_anchor"], "source_id": manifest["source"]["source_id"],
            "candidate_id": manifest["source"]["candidate_id"], "image_sha256": manifest["image"]["sha256"]}


def catalog_entries(folder):
    with os.scandir(folder) as iterator:
        entries = list(islice(iterator, MAX_PARTS + 2))
    require(len(entries) <= MAX_PARTS + 1, "Independent part catalog exceeds its size limit.")
    identifiers = []
    for entry in entries:
        require(entry.is_dir(follow_symlinks=False), "Invalid independent part catalog entry.")
        if entry.name == STAGING:
            continue
        require(matches(ID["pt"], entry.name), "Invalid independent part catalog entry.")
        identifiers.append(entry.name)
    require(len(identifiers) <= MAX_PARTS, "Independent part catalog exceeds its size limit.")
    return sorted(identifiers)


def clear_staging(folder):
    paths = []
    with ExitStack() as opened:
        try:
            staging = opened.enter_context(private_directory(folder, STAGING, paths))
        except FileNotFoundError:
            return
        allowed = {*FILES, *(".tmp-" + name for name in FILES)}
        with os.scandir(staging) as entries:
            names = [entry.name for entry in islice(entries, len(allowed) + 1)]
        require(set(names) <= allowed, "Unexpected file in independent part staging.")
        for name in names:
            remove_temporary_file(staging, name)
        recheck(paths, ())
        os.rmdir(STAGING, dir_fd=folder)


def register(state, args, paths):
    candidate_id = args["candidate_id"]
    snapshots = []
    with ExitStack() as opened:
        candidates = opened.enter_context(private_directory(state, "segment_candidates", paths))
        lock(candidates, fcntl.LOCK_SH)
        candidate_dir = opened.enter_context(private_directory(candidates, candidate_id, paths))
        candidate = read_manifest(candidate_dir, snapshots)
        require(candidate.get("candidate_id") == candidate_id and
                candidate.get("part_png_sha256") == args["expected_candidate_sha256"],
                "Saved candidate ID or SHA-256 changed. Review the candidate again.")
        png = private_file(candidate_dir, "part.png", MAX_CANDIDATE_BYTES, snapshots)
        manifest, atlas = prepare_catalog_part(candidate, png, kind_id=args["kind_id"],
                                             layer_anchor=args["layer_anchor"], rights=args["rights"])
        source = manifest["source"]
        characters = opened.enter_context(private_directory(state, "character_parts", paths))
        lock(characters, fcntl.LOCK_SH)
        character = opened.enter_context(private_directory(characters, source["source_id"], paths))
        original = read_source(character, source, snapshots)
        left = source["source_frame"] * WIDTH
        cell = original.crop((left, 0, left + WIDTH, HEIGHT))
        cutout = verified_png(png, source["candidate_sha256"], (WIDTH, HEIGHT), MAX_CANDIDATE_BYTES).tobytes()
        original_pixels = cell.tobytes()
        require(all(not cutout[i + 3] or (cutout[i + 3] >= 16 and cutout[i:i+4] == original_pixels[i:i+4])
                    for i in range(0, len(cutout), 4)),
                "Candidate pixels do not match the recorded source frame.")
        recheck(paths, snapshots)
        catalog = opened.enter_context(private_directory(state, CATALOG, paths, create=True))
        lock(catalog, fcntl.LOCK_EX)
        require(len(catalog_entries(catalog)) < MAX_PARTS, "Independent part catalog is full (32 entries).")
        clear_staging(catalog)
        os.mkdir(STAGING, mode=0o700, dir_fd=catalog)
        try:
            with private_directory(catalog, STAGING, paths) as staging:
                for name, data, limit in (("part.png", atlas, MAX_ATLAS_BYTES),
                                          ("manifest.json", json_bytes(manifest), MAX_MANIFEST)):
                    publish(staging, name, data, limit)
                    require(private_file(staging, name, limit, snapshots) == data,
                            "Staged independent part changed before publication.")
                recheck(paths, snapshots)
                move_exclusive(catalog, STAGING, manifest["part_id"])
                os.fsync(catalog)
        finally:
            clear_staging(catalog)
    return metadata(manifest)


def read_part(catalog, identifier, paths, *, include_image=False):
    snapshots = []
    part_paths = list(paths)
    with private_directory(catalog, identifier, part_paths) as folder:
        manifest = read_manifest(folder, snapshots)
        require(manifest.get("part_id") == identifier, "Independent part ID does not match its entry.")
        png = private_file(folder, "part.png", MAX_ATLAS_BYTES, snapshots)
        validate_catalog_part(manifest, png)
        recheck(part_paths, snapshots)
        if include_image:
            return {"part_id": identifier, "image_sha256": manifest["image"]["sha256"],
                    "png_base64": base64.b64encode(png).decode("ascii")}
        return metadata(manifest)


def run(operation, args):
    require(sys.platform == "linux" and isinstance(args, dict), "Independent part catalog requires Linux and JSON.")
    if operation == "register":
        require(set(args) == {"candidate_id", "expected_candidate_sha256", "kind_id", "layer_anchor", "rights"} and
                matches(ID["sg"], args["candidate_id"]) and matches(SHA256, args["expected_candidate_sha256"]),
                "Invalid independent part registration arguments.")
        validate_placement(args["kind_id"], args["layer_anchor"])
        validate_rights(args["rights"])
    elif operation in ("validate", "image"):
        require(set(args) == {"part_id"} and matches(ID["pt"], args["part_id"]), "Invalid independent part ID.")
    else:
        require(operation == "list" and not args, "Invalid independent part operation.")

    paths = []
    with ExitStack() as opened:
        root = opened.enter_context(directory(ROOT))
        if operation == "register":
            state = opened.enter_context(private_directory(root, "local_state", paths, state=True))
            return register(state, args, paths)
        try:
            state = opened.enter_context(private_directory(root, "local_state", paths, state=True))
            catalog = opened.enter_context(private_directory(state, CATALOG, paths))
        except FileNotFoundError:
            if operation == "list":
                return {"parts": []}
            if operation == "image":
                raise PartNotFound("Independent part not found.") from None
            raise
        lock(catalog, fcntl.LOCK_SH)
        if operation == "image":
            identifier = args["part_id"]
            try:
                os.stat(identifier, dir_fd=catalog, follow_symlinks=False)
            except FileNotFoundError:
                raise PartNotFound("Independent part not found.") from None
            return read_part(catalog, identifier, paths, include_image=True)
        if operation == "validate":
            return read_part(catalog, args["part_id"], paths)
        parts = [read_part(catalog, identifier, paths) for identifier in catalog_entries(catalog)]
        recheck(paths, ())
        return {"parts": parts}


def main():
    require(sys.platform == "linux" and len(sys.argv) == 2, "Independent part catalog requires a Linux operation.")
    os.umask(0o077)
    raw = sys.stdin.buffer.readline(MAX_REQUEST + 1)
    require(raw.endswith(b"\n") and len(raw) <= MAX_REQUEST and not sys.stdin.buffer.read(1),
            "Expected one bounded JSON input line.")
    return run(sys.argv[1], json_object(raw))


if __name__ == "__main__":
    try:
        print(json.dumps({"result": main()}, ensure_ascii=True))
    except PartNotFound:
        print(json.dumps({"error": "Independent part not found.", "code": "not_found"}))
    except (PartsError, PartValidationError) as exc:
        print(json.dumps({"error": str(exc)}))
    except FileNotFoundError:
        print(json.dumps({"error": "A required local catalog entry or file is missing."}))
    except (OSError, RecursionError, TypeError, ValueError):
        print(json.dumps({"error": "Local part catalog data is invalid or could not be accessed safely."}))

"""Fixed local storage and packaging for the private character parts tools."""
import ctypes
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid
import zipfile
from contextlib import contextmanager
from itertools import islice

WIDTH, HEIGHT, FRAMES = 192, 208, 6
MAX_FILE = 512 * 1024
MAX_MANIFEST = 4096
MAX_ZIP = 3 * 1024 * 1024
MAX_CHARACTERS = 32
MAX_INPUT = 1024
STAGING = ".tmp-generation"
MODEL = "creature-lab-chibi-v1"
ENGINE = "original-template"
PROVENANCE = "Drawn from project-authored geometric primitives using Python Pillow."
PARTS = {key: f"character_{key}_6frames.png" for key in ("body", "ready", "happy", "cautious")}
ASSETS = (*PARTS.values(), "preview.gif")
ROOT = Path(__file__).resolve().parent.parent
ID_PATTERN = re.compile(r"cp_[0-9a-f]{32}")


class PartsError(Exception):
    pass


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=True, indent=2) + "\n").encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


@contextmanager
def directory(path, parent=None, create=False):
    if create:
        try:
            os.mkdir(path, mode=0o700, dir_fd=parent)
            if parent is not None:
                os.fsync(parent)
            else:
                with directory(path.parent) as ancestor:
                    os.fsync(ancestor)
        except FileExistsError:
            pass
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        yield fd
    finally:
        os.close(fd)


def read_file(parent, name, limit):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    with os.fdopen(fd, "rb") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= limit:
            raise PartsError("Generated character contains an invalid local file.")
        data = file.read(limit + 1)
    if not 0 < len(data) <= limit:
        raise PartsError("Generated character contains an invalid local file.")
    return data


def move_exclusive(parent, source, destination):
    # Linux renameat2 with RENAME_NOREPLACE also protects empty directories.
    rename = ctypes.CDLL(None, use_errno=True).renameat2
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                       ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(parent, os.fsencode(source), parent, os.fsencode(destination), 1):
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def remove_temporary_file(parent, name):
    try:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600):
        raise PartsError("Unsafe temporary character artifact.")
    os.unlink(name, dir_fd=parent)


def clear_staging(root):
    # The caller holds the root flock. Reclaim only our private, reserved names.
    try:
        with directory(STAGING, root) as folder:
            info = os.fstat(folder)
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise PartsError("Unsafe temporary character directory.")
            for name in (*ASSETS, "manifest.json", "demo.json"):
                remove_temporary_file(folder, name)
                remove_temporary_file(folder, ".tmp-" + name)
    except FileNotFoundError:
        return
    os.rmdir(STAGING, dir_fd=root)


def publish(parent, name, data, limit, repeat=False):
    if len(data) > limit:
        raise PartsError("Generated artifact exceeds the size limit.")
    if repeat:
        try:
            if read_file(parent, name, limit) == data:
                return
        except FileNotFoundError:
            pass
        else:
            raise PartsError("Existing local artifact differs from the generated result.")
    temporary = ".tmp-" + name
    remove_temporary_file(parent, temporary)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=parent)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        move_exclusive(parent, temporary, name)
        os.fsync(parent)
    finally:
        remove_temporary_file(parent, temporary)


def checked_appearance(value):
    if (set(value) != {"name", "hair_color", "clothing_color", "accessory", "seed"}
            or not 1 <= len(value["name"]) <= 16
            or not value["name"].strip()
            or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in value["name"])
            or not all(re.fullmatch(r"#[a-fA-F0-9]{6}", value[key])
                       for key in ("hair_color", "clothing_color"))
            or value["accessory"] not in ("none", "ribbon", "glasses", "star")
            or type(value["seed"]) is not int or not 0 <= value["seed"] <= 65535):
        raise PartsError("Invalid character appearance.")
    return value


def asset_info(data, width, height):
    return {"bytes": len(data), "sha256": digest(data), "width": width,
            "height": height, "frames": FRAMES}


def generate(root, appearance):
    clear_staging(root)
    with os.scandir(root) as entries:
        if len(list(islice(entries, MAX_CHARACTERS))) >= MAX_CHARACTERS:
            raise PartsError("Local character storage is full (32 entries).")
    try:
        from character_parts_render import render
    except ModuleNotFoundError as error:
        if error.name == "PIL":
            raise PartsError("Python Pillow is required to generate character parts.") from error
        raise

    layers, preview = render(appearance)
    assets = {}
    for key, image in layers.items():
        encoded = io.BytesIO()
        image.save(encoded, format="PNG")
        assets[PARTS[key]] = encoded.getvalue()
    encoded = io.BytesIO()
    preview[0].save(encoded, format="GIF", save_all=True, append_images=preview[1:],
                    duration=130, loop=0, disposal=2)
    assets["preview.gif"] = encoded.getvalue()

    identifier = "cp_" + uuid.uuid4().hex
    manifest = {
        "schema_version": 1, "generated_id": identifier, "name": appearance["name"],
        "engine": ENGINE, "model": MODEL, "source_provenance": PROVENANCE,
        "appearance": appearance,
        "layout": {"frames": FRAMES, "columns": FRAMES, "rows": 1,
                   "cell_width": WIDTH, "cell_height": HEIGHT},
        "files": {name: asset_info(data, WIDTH if name == "preview.gif" else WIDTH * FRAMES, HEIGHT)
                  for name, data in assets.items()},
    }
    os.mkdir(STAGING, mode=0o700, dir_fd=root)
    try:
        with directory(STAGING, root) as folder:
            for name, data in assets.items():
                publish(folder, name, data, MAX_FILE)
            publish(folder, "manifest.json", json_bytes(manifest), MAX_MANIFEST)
        move_exclusive(root, STAGING, identifier)
        os.fsync(root)
    finally:
        clear_staging(root)
    return manifest


def load_generated(folder, identifier):
    raw = read_file(folder, "manifest.json", MAX_MANIFEST)
    manifest = json.loads(raw)
    if (manifest["schema_version"] != 1 or manifest["generated_id"] != identifier
            or manifest["engine"] != ENGINE or manifest["model"] != MODEL
            or manifest["source_provenance"] != PROVENANCE or set(manifest["files"]) != set(ASSETS)):
        raise PartsError("Invalid generated character manifest.")
    appearance = checked_appearance(manifest["appearance"])
    if manifest["name"] != appearance["name"]:
        raise PartsError("Invalid generated character name.")
    files = {}
    for name in ASSETS:
        data = read_file(folder, name, MAX_FILE)
        width = WIDTH if name == "preview.gif" else WIDTH * FRAMES
        if manifest["files"][name] != asset_info(data, width, HEIGHT):
            raise PartsError("Generated character failed SHA-256 or metadata verification.")
        files[name] = data
    files["manifest.json"] = raw
    return manifest, files


def use_generated(root, operation, identifier):
    try:
        with directory(identifier, root) as folder:
            manifest, files = load_generated(folder, identifier)
            if operation == "package":
                archive = io.BytesIO()
                with zipfile.ZipFile(archive, "w") as zip_file:
                    for name, data in files.items():
                        zip_file.writestr(zipfile.ZipInfo(name), data)
                data = archive.getvalue()
                publish(folder, "character_parts.zip", data, MAX_ZIP, repeat=True)
                return {"generated_id": identifier, "engine": ENGINE,
                        "filename": "character_parts.zip", "bytes": len(data),
                        "sha256": digest(data), "browser_import": "select_zip_in_parts_lab"}
            entry = {"generated_id": identifier, "name": manifest["name"], "engine": ENGINE,
                     "model": MODEL, "visibility": "local_only", "browser_auto_link": False}
            publish(folder, "demo.json", json_bytes(entry), MAX_MANIFEST, repeat=True)
            return entry
    except FileNotFoundError as error:
        raise PartsError("Generated character ID is unknown or incomplete.") from error
    except (KeyError, TypeError, ValueError) as error:
        raise PartsError("Invalid generated character manifest.") from error


def run(operation, payload):
    if operation not in ("generate", "package", "register"):
        raise PartsError("Unsupported character parts operation.")
    create = operation == "generate"
    if create:
        checked_appearance(payload)
    elif (set(payload) != {"generated_id"} or not isinstance(payload["generated_id"], str)
          or not ID_PATTERN.fullmatch(payload["generated_id"])):
        raise PartsError("Invalid generated character ID.")
    with directory(ROOT / "local_state", create=create) as state:
        with directory("character_parts", state, create=create) as root:
            # All helper processes share this lock, including distinct HTTP/stdio instances.
            try:
                fcntl.flock(root, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise PartsError("Character parts storage is busy. Try again.") from error
            if create:
                return generate(root, payload)
            return use_generated(root, operation, payload["generated_id"])


def read_request(args, stream):
    if len(args) != 1 or args[0] not in ("generate", "package", "register"):
        raise PartsError("Unsupported character parts operation.")
    raw = stream.readline(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT or not raw.endswith(b"\n") or stream.read(1):
        raise PartsError("Expected one bounded JSON input line.")
    try:
        payload = json.loads(raw)
    except (ValueError, RecursionError) as error:
        raise PartsError("Invalid character parts JSON.") from error
    if not isinstance(payload, dict):
        raise PartsError("Expected a character parts object.")
    return args[0], payload


if __name__ == "__main__":
    try:
        os.umask(0o077)
        operation, payload = read_request(sys.argv[1:], sys.stdin.buffer)
        print(json.dumps({"result": run(operation, payload)}, ensure_ascii=True))
    except PartsError as error:
        print(json.dumps({"error": str(error)}))
    except (KeyError, TypeError, ValueError):
        print(json.dumps({"error": "Invalid character parts input."}))
    except FileNotFoundError:
        print(json.dumps({"error": "Generated character storage does not exist."}))
    except OSError:
        print(json.dumps({"error": "Could not access local character parts storage safely."}))

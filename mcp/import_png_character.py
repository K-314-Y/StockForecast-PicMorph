"""Register user-supplied, browser-normalized 6-frame PNG parts in the private local catalog.

Fixed in-memory JSON protocol; no user-controlled paths, shell or overwrite.
Registered artwork is private to this Linux computer. No model or XP writes.
"""
import base64
import binascii
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid
from itertools import islice

from character_parts import (
    ROOT, WIDTH, HEIGHT, FRAMES, MAX_FILE, MAX_MANIFEST, MAX_CHARACTERS,
    PARTS, STAGING, PartsError, directory, clear_staging, publish,
    move_exclusive, json_bytes, digest
)

ENGINE = "user-png"
MODEL = "creature-lab-user-png-v1"
PROVENANCE = "User-supplied local PNG parts, normalized in the browser."
MAX_REQUEST = 3 * 1024 * 1024
APPEARANCE = {"schema_version": 1, "frames": FRAMES}
NAME = re.compile(r"^[^\x00-\x1f\x7f-\x9f]{1,16}$")
B64 = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")


def read_payload(stream):
    raw = stream.readline(MAX_REQUEST + 1)
    if not raw.endswith(b"\n") or len(raw) > MAX_REQUEST or stream.read(1):
        raise PartsError("Upload request must be bounded JSON.")
    try:
        value = json.loads(raw)
    except (ValueError, RecursionError):
        raise PartsError("Invalid PNG upload JSON.")
    if not isinstance(value, dict) or set(value) != {"name", "parts"}:
        raise PartsError("PNG upload must specify name and four parts.")
    name = value["name"]
    if (not isinstance(name, str) or not NAME.fullmatch(name)
            or not name.strip() or name != name.strip()):
        raise PartsError("Invalid PNG character name.")
    if not isinstance(value["parts"], dict) or set(value["parts"]) != set(PARTS):
        raise PartsError("Four PNG parts are required.")
    return value


def decode_part(name, value):
    if not isinstance(value, str) or len(value) > 720000 or not B64.fullmatch(value):
        raise PartsError("Invalid PNG part encoding.")
    try:
        data = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise PartsError("Invalid PNG part encoding.")
    if not 0 < len(data) <= MAX_FILE:
        raise PartsError("PNG part exceeds size limit.")
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise PartsError("Only PNG parts are accepted.")
    from PIL import Image
    try:
        image = Image.open(io.BytesIO(data))
        if (image.format != "PNG" or image.mode != "RGBA" or
                image.size != (WIDTH * FRAMES, HEIGHT)):
            raise PartsError("PNG must be RGBA and 1152 x 208 pixels.")
        image.load()
        if name != "body" and image.getextrema()[3][0] == 255:
            raise PartsError("Face PNGs must have transparent background.")
    except (OSError, SyntaxError, ValueError, EOFError) as error:
        raise PartsError("PNG image is invalid.") from error
    return data


def register(payload):
    name = payload["name"]
    images = {key: decode_part(key, value) for key, value in payload["parts"].items()}
    # Reuse the same dirfd / no-follow / exclusive publish discipline as the MCP generator.
    with directory(ROOT / "local_state", create=True) as state:
        with directory("character_parts", state, create=True) as root:
            import fcntl
            try:
                fcntl.flock(root, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise PartsError("Character storage is busy.")
            clear_staging(root)
            with os.scandir(root) as entries:
                if len(list(islice(entries, MAX_CHARACTERS))) >= MAX_CHARACTERS:
                    raise PartsError("Local character storage is full.")
            identifier = "cp_" + uuid.uuid4().hex
            files = {}
            for key, image in images.items():
                files[PARTS[key]] = {
                    "bytes": len(image), "sha256": digest(image),
                    "width": WIDTH * FRAMES, "height": HEIGHT, "frames": FRAMES,
                }
            manifest = {
                "schema_version": 1, "generated_id": identifier, "name": name,
                "engine": ENGINE, "model": MODEL,
                "source_provenance": PROVENANCE,
                "layout": {
                    "frames": FRAMES, "columns": FRAMES, "rows": 1,
                    "cell_width": WIDTH, "cell_height": HEIGHT,
                },
                "files": files,
            }
            demo = {
                "generated_id": identifier, "name": name, "engine": ENGINE,
                "model": MODEL, "visibility": "local_only",
                "browser_auto_link": False,
            }
            os.mkdir(STAGING, mode=0o700, dir_fd=root)
            try:
                with directory(STAGING, root) as folder:
                    for key, image in images.items():
                        publish(folder, PARTS[key], image, MAX_FILE)
                    publish(folder, "manifest.json", json_bytes(manifest), MAX_MANIFEST)
                    publish(folder, "demo.json", json_bytes(demo), MAX_MANIFEST)
                move_exclusive(root, STAGING, identifier)
                os.fsync(root)
            finally:
                clear_staging(root)
            return {"generated_id": identifier, "name": name, "engine": ENGINE,
                    "registered": True}


if __name__ == "__main__":
    try:
        os.umask(0o077)
        if sys.argv[1:] != ["register_upload"]:
            raise PartsError("Unsupported PNG operation.")
        result = register(read_payload(sys.stdin.buffer))
        print(json.dumps({"result": result}, ensure_ascii=True))
    except PartsError as error:
        print(json.dumps({"error": str(error)}))
    except (KeyError, TypeError, ValueError):
        print(json.dumps({"error": "Invalid PNG upload input."}))
    except (OSError, ImportError):
        print(json.dumps({"error": "PNG upload storage is unavailable."}))

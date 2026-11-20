"""Preview and explicitly save guided component masks from verified 6-frame PNGs.

The semantic decision (eyes, hair, accessory, etc.) and seed points come from
the invoking AI or user. This helper is NOT a trained semantic segmentation
model. It flood-fills local similarly colored, opaque pixels. Preview writes
nothing; save publishes to a new isolated directory, never overwriting art.
"""
import base64
import binascii
from collections import deque
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid
import fcntl
from itertools import islice

from PIL import Image
from character_parts import ROOT, PartsError, directory, publish, json_bytes, move_exclusive

WIDTH, HEIGHT, FRAMES = 192, 208, 6
MAX_SOURCE = 512 * 1024
MAX_REQUEST = 750000
MAX_SAVED = 48
CATEGORIES = frozenset(("eyes", "mouth", "eyebrows", "cheeks", "hair", "outfit",
                        "ribbon", "glasses", "hat", "earrings", "accessory"))
SOURCE_PARTS = frozenset(("body", "ready", "happy", "cautious"))
ID_PATTERN = re.compile(r"cp_[0-9a-f]{32}")
HEX_PATTERN = re.compile(r"[0-9a-f]{64}")


def validate(raw):
    if not isinstance(raw, dict) or set(raw) not in (
            {"mode", "generated_id", "source_part", "part_type", "frame",
             "seeds", "tolerance", "source_png"},
            {"mode", "generated_id", "source_part", "part_type", "frame",
             "seeds", "tolerance", "source_png", "expected_sha256"}):
        raise PartsError("Invalid segmentation arguments.")
    mode = raw["mode"]
    if mode not in ("preview", "save") or (mode == "save") != ("expected_sha256" in raw):
        raise PartsError("Invalid preview/save operation.")
    if not isinstance(raw["generated_id"], str) or not ID_PATTERN.fullmatch(raw["generated_id"]):
        raise PartsError("Invalid local character ID.")
    if raw["source_part"] not in SOURCE_PARTS or raw["part_type"] not in CATEGORIES:
        raise PartsError("Unknown image part or target category.")
    if type(raw["frame"]) is not int or not 0 <= raw["frame"] < FRAMES:
        raise PartsError("Frame index must be 0-5.")
    if type(raw["tolerance"]) is not int or not 0 <= raw["tolerance"] <= 64:
        raise PartsError("Tolerance must be between 0 and 64.")
    seeds = raw["seeds"]
    if (not isinstance(seeds, list) or not 1 <= len(seeds) <= 6 or
            any(not isinstance(p, dict) or set(p) != {"x", "y"} or
                type(p["x"]) is not int or type(p["y"]) is not int or
                not 0 <= p["x"] < WIDTH or not 0 <= p["y"] < HEIGHT for p in seeds)):
        raise PartsError("Seed points must be within a 192 x 208 frame.")
    encoded = raw["source_png"]
    if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_SOURCE + 2) // 3) or len(encoded) % 4:
        raise PartsError("Source PNG is too large.")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise PartsError("Invalid source PNG encoding.")
    if not 0 < len(data) <= MAX_SOURCE or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise PartsError("Not a valid registered PNG.")
    digest = hashlib.sha256(data).hexdigest()
    if mode == "save" and (not isinstance(raw["expected_sha256"], str) or
                            not HEX_PATTERN.fullmatch(raw["expected_sha256"]) or
                            digest != raw["expected_sha256"]):
        raise PartsError("The original PNG has changed; preview the candidate again.")
    return raw, data, digest


def extract(request, source):
    try:
        image = Image.open(io.BytesIO(source))
        if image.format != "PNG" or image.mode != "RGBA" or image.size != (WIDTH * FRAMES, HEIGHT):
            raise PartsError("The registered source must be 1152 x 208 RGBA PNG.")
        image.load()
    except (OSError, SyntaxError, EOFError, ValueError) as exc:
        raise PartsError("Source PNG is damaged or unsupported.") from exc
    frame = request["frame"]
    image = image.crop((frame * WIDTH, 0, (frame + 1) * WIDTH, HEIGHT))
    pixels = image.load()
    region = bytearray(WIDTH * HEIGHT)
    tolerance = request["tolerance"]
    for seed in request["seeds"]:
        sx, sy = seed["x"], seed["y"]
        r0, g0, b0, a0 = pixels[sx, sy]
        if a0 < 16:
            raise PartsError("Seed points must be on an opaque visible part.")
        visited = bytearray(WIDTH * HEIGHT)
        queue = deque([(sx, sy)])
        while queue:
            x, y = queue.popleft()
            i = y * WIDTH + x
            if visited[i]:
                continue
            visited[i] = 1
            r, g, b, a = pixels[x, y]
            if a < 16 or max(abs(r-r0), abs(g-g0), abs(b-b0)) > tolerance:
                continue
            region[i] = 1
            if x > 0: queue.append((x-1, y))
            if x+1 < WIDTH: queue.append((x+1, y))
            if y > 0: queue.append((x, y-1))
            if y+1 < HEIGHT: queue.append((x, y+1))
    count = sum(region)
    if count < 4:
        raise PartsError("Mask is too small; choose a point in a solid-colored part.")
    if count >= WIDTH*HEIGHT*0.84:
        raise PartsError("Mask is too large; use a lower tolerance or a different point.")
    mask = Image.new("L", (WIDTH, HEIGHT), 0)
    mask.putdata(bytes(255 if region[i] else 0 for i in range(WIDTH*HEIGHT)))
    bbox = mask.getbbox()
    output = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    output.paste(image, (0, 0), mask)
    encoded = io.BytesIO()
    output.save(encoded, format="PNG", optimize=True)
    data = encoded.getvalue()
    if len(data) > MAX_SOURCE:
        raise PartsError("The separated PNG exceeds the local size limit.")
    return data, {
        "frame": frame, "part_type": request["part_type"],
        "source_part": request["source_part"], "bbox": list(bbox),
        "mask_pixels": count, "coverage_percent": round(count*100/(WIDTH*HEIGHT), 2),
        "width": WIDTH, "height": HEIGHT,
        "method": "ai-guided-color-region", "semantic_model_used": False,
        "review_required": True,
    }


def save(request, data, metadata, source_hash):
    identifier = "sg_" + uuid.uuid4().hex
    with directory(ROOT / "local_state", create=True) as parent:
        with directory("segment_candidates", parent, create=True) as folder:
            info = os.fstat(folder)
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise PartsError("Unsafe local candidate directory.")
            fcntl.flock(folder, fcntl.LOCK_EX)
            with os.scandir(folder) as entries:
                if len(list(islice(entries, MAX_SAVED))) >= MAX_SAVED:
                    raise PartsError("Candidate storage is full.")
            os.mkdir(identifier, mode=0o700, dir_fd=folder)
            try:
                with directory(identifier, folder) as target:
                    publish(target, "part.png", data, MAX_SOURCE)
                    publish(target, "manifest.json", json_bytes({
                        "schema_version": 1, "candidate_id": identifier,
                        "source_id": request["generated_id"],
                        "source_sha256": source_hash,
                        "part_type": request["part_type"],
                        "seed_points": request["seeds"],
                        "tolerance": request["tolerance"],
                        "metadata": metadata,
                        "part_png_sha256": hashlib.sha256(data).hexdigest(),
                        "not_registered_in_game": True,
                    }), 4096)
                os.fsync(folder)
            except BaseException:
                # A newly allocated ID belongs only to this call.
                with directory(identifier, folder) as target:
                    for filename in ("part.png", "manifest.json"):
                        try: os.unlink(filename, dir_fd=target)
                        except FileNotFoundError: pass
                        try: os.unlink(".tmp-"+filename, dir_fd=target)
                        except FileNotFoundError: pass
                os.rmdir(identifier, dir_fd=folder)
                raise
    return {"candidate_id": identifier,
            "local_directory": "local_state/segment_candidates/" + identifier,
            "filename": "part.png",
            "registered_in_game": False,
            **metadata}


def main():
    raw = sys.stdin.buffer.readline(MAX_REQUEST + 1)
    if not raw.endswith(b"\n") or len(raw) > MAX_REQUEST or sys.stdin.buffer.read(1):
        raise PartsError("Segment request too large.")
    try: value = json.loads(raw)
    except (ValueError, RecursionError): raise PartsError("Invalid segmentation JSON.")
    request, source, source_hash = validate(value)
    png, metadata = extract(request, source)
    if request["mode"] == "preview":
        result = {"preview_png_base64": base64.b64encode(png).decode("ascii"),
                  "source_sha256": source_hash,
                  "generated_id": request["generated_id"],
                  **metadata}
    else:
        result = save(request, png, metadata, source_hash)
    print(json.dumps({"result": result}, ensure_ascii=True))


if __name__ == "__main__":
    try:
        os.umask(0o077)
        main()
    except PartsError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=True))
    except (OSError, ImportError, KeyError, TypeError, ValueError, RecursionError):
        print(json.dumps({"error": "Segmentation helper could not complete."}))

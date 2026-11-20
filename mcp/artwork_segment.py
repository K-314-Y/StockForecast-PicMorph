"""Preview and explicitly save guided component masks from verified 6-frame PNGs.

The invoking AI or user chooses the category and seed points. An optional
EfficientSAM worker predicts a point-guided mask. By default, Pillow selects
connected pixels of similar color. Preview writes nothing. Save publishes to
a new isolated directory.
"""
import base64
import binascii
from collections import deque
import hashlib
import io
import json
import os
import re
import stat
import sys
import uuid
import fcntl
from itertools import islice

from PIL import Image
from character_parts import (
    ROOT, PartsError, directory, json_bytes, move_exclusive, publish, remove_temporary_file,
)
from segment_onnx import (
    HEIGHT, MAX_MASK_PIXELS, MIN_MASK_PIXELS, NEURAL_METHOD, WIDTH, try_mask,
)

FRAMES = 6
MAX_SOURCE = 512 * 1024
MAX_REQUEST = 750000
MAX_SAVED = 48
CATEGORIES = frozenset(("eyes", "mouth", "eyebrows", "cheeks", "hair", "outfit",
                        "ribbon", "glasses", "hat", "earrings", "accessory"))
SOURCE_PARTS = frozenset(("body", "ready", "happy", "cautious"))
ID_PATTERN = re.compile(r"cp_[0-9a-f]{32}")
HEX_PATTERN = re.compile(r"[0-9a-f]{64}")
COLOR_METHOD = "ai-guided-color-region"
STAGING = ".staging-segment"


def validate(raw):
    required = {"mode", "generated_id", "source_part", "part_type", "frame",
                "seeds", "tolerance", "source_png"}
    if (not isinstance(raw, dict) or not required <= set(raw) or
            set(raw) - required - {"expected_sha256", "review"}):
        raise PartsError("Invalid segmentation arguments.")
    mode = raw["mode"]
    if mode not in ("preview", "save") or (mode == "save") != ("expected_sha256" in raw):
        raise PartsError("Invalid preview/save operation.")
    if "review" in raw:
        review = raw["review"]
        if (mode != "save" or not isinstance(review, dict) or set(review) != {"method", "sha256"} or
                review["method"] not in (NEURAL_METHOD, COLOR_METHOD) or
                not isinstance(review["sha256"], str) or not HEX_PATTERN.fullmatch(review["sha256"])):
            raise PartsError("Invalid candidate review.")
    elif mode == "save":
        raise PartsError("Review the candidate preview before saving.")
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


def color_region(pixels, points, tolerance):
    region = bytearray(WIDTH * HEIGHT)
    for sx, sy in points:
        r0, g0, b0, _ = pixels[sx, sy]
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
    return region


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
    points = [(seed["x"], seed["y"]) for seed in request["seeds"]]
    if any(pixels[point][3] < 16 for point in points):
        raise PartsError("Seed points must be on an opaque visible part.")
    review = request.get("review")
    region, fallback = (None, None)
    if not review or review["method"] != COLOR_METHOD:
        region, fallback = try_mask(image, points)
    if region is None:
        if review and review["method"] == NEURAL_METHOD:
            raise PartsError("The reviewed neural mask is unavailable; preview the candidate again.")
        region = color_region(pixels, points, request["tolerance"])
        method = COLOR_METHOD
    else:
        method = NEURAL_METHOD
    count = sum(region)
    if count < MIN_MASK_PIXELS:
        raise PartsError("Mask is too small; choose a point in a solid-colored part.")
    if count >= MAX_MASK_PIXELS:
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
        "method": method, "semantic_model_used": False,
        "neural_model_used": method == NEURAL_METHOD, "review_required": True,
        **({"fallback_reason": fallback} if fallback else {}),
    }


def check_private(folder):
    info = os.fstat(folder)
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise PartsError("Unsafe local candidate directory.")


def clear_staging(folder):
    try:
        with directory(STAGING, folder) as staging:
            check_private(staging)
            for name in ("part.png", "manifest.json"):
                remove_temporary_file(staging, name)
                remove_temporary_file(staging, ".tmp-" + name)
    except FileNotFoundError:
        return
    os.rmdir(STAGING, dir_fd=folder)


def save(request, data, metadata, source_hash, candidate_hash):
    identifier = "sg_" + uuid.uuid4().hex
    with directory(ROOT / "local_state", create=True) as parent:
        parent_info = os.fstat(parent)
        if parent_info.st_uid != os.geteuid() or parent_info.st_mode & stat.S_IWOTH:
            raise PartsError("Unsafe local state directory.")
        with directory("segment_candidates", parent, create=True) as folder:
            check_private(folder)
            try:
                fcntl.flock(folder, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise PartsError("Candidate storage is busy. Try again.") from exc
            clear_staging(folder)
            with os.scandir(folder) as entries:
                if len(list(islice(entries, MAX_SAVED))) >= MAX_SAVED:
                    raise PartsError("Candidate storage is full.")
            os.mkdir(STAGING, mode=0o700, dir_fd=folder)
            try:
                with directory(STAGING, folder) as target:
                    publish(target, "part.png", data, MAX_SOURCE)
                    publish(target, "manifest.json", json_bytes({
                        "schema_version": 1, "candidate_id": identifier,
                        "source_id": request["generated_id"],
                        "source_sha256": source_hash,
                        "part_type": request["part_type"],
                        "seed_points": request["seeds"],
                        "tolerance": request["tolerance"],
                        "metadata": metadata,
                        "part_png_sha256": candidate_hash,
                        "not_registered_in_game": True,
                    }), 4096)
                entry = os.stat("segment_candidates", dir_fd=parent, follow_symlinks=False)
                if not os.path.samestat(entry, os.fstat(folder)):
                    raise PartsError("Candidate storage moved. Preview the candidate again.")
                move_exclusive(folder, STAGING, identifier)
                os.fsync(folder)
            finally:
                clear_staging(folder)
    return {"candidate_id": identifier,
            "local_directory": "local_state/segment_candidates/" + identifier,
            "filename": "part.png",
            "registered_in_game": False,
            "part_png_sha256": candidate_hash, **metadata}


def main():
    raw = sys.stdin.buffer.readline(MAX_REQUEST + 1)
    if not raw.endswith(b"\n") or len(raw) > MAX_REQUEST or sys.stdin.buffer.read(1):
        raise PartsError("Segment request too large.")
    try: value = json.loads(raw)
    except (ValueError, RecursionError): raise PartsError("Invalid segmentation JSON.")
    request, source, source_hash = validate(value)
    png, metadata = extract(request, source)
    candidate_hash = hashlib.sha256(png).hexdigest()
    if request["mode"] == "preview":
        result = {"preview_png_base64": base64.b64encode(png).decode("ascii"),
                  "source_sha256": source_hash,
                  "part_png_sha256": candidate_hash,
                  "generated_id": request["generated_id"],
                  **metadata}
    else:
        if candidate_hash != request["review"]["sha256"]:
            raise PartsError("The candidate mask changed; preview the candidate again.")
        result = save(request, png, metadata, source_hash, candidate_hash)
    print(json.dumps({"result": result}, ensure_ascii=True))


if __name__ == "__main__":
    try:
        os.umask(0o077)
        main()
    except PartsError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=True))
    except (OSError, ImportError, KeyError, TypeError, ValueError, RecursionError):
        print(json.dumps({"error": "Segmentation helper could not complete."}))

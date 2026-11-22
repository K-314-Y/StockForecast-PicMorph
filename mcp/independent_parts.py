"""Prepare and validate detached catalog parts from explicitly selected cutouts.

Both entry points operate on supplied data in memory. The caller owns approval
and any later persistence. A candidate manifest is provenance, not a signature.
"""

import hashlib
import io
import re
import unicodedata
import uuid

from PIL import Image


WIDTH, HEIGHT, FRAMES = 192, 208, 6
ATLAS_SIZE = (WIDTH * FRAMES, HEIGHT)
MAX_CANDIDATE_BYTES = 512 * 1024
MAX_ATLAS_BYTES = 1024 * 1024
ATLAS_LAYOUT = {"filename": "part.png", "width": ATLAS_SIZE[0], "height": HEIGHT,
                "frames": FRAMES, "frame_width": WIDTH, "frame_mode": "static-repeat"}
ID = {prefix: re.compile(prefix + r"_[0-9a-f]{32}") for prefix in ("sg", "cp", "pt")}
SHA256 = re.compile(r"[0-9a-f]{64}")
KIND = re.compile(r"[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+")
SOURCE_PARTS = ("body", "ready", "happy", "cautious")
# In back-to-front order. Each independent layer sits above its anchor and
# below the next one, matching the /game artwork order.
LAYER_ANCHORS = ("base", "outfit", "face", "hair")


class PartValidationError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise PartValidationError(message)


def matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def validate_placement(kind_id, anchor):
    require(isinstance(kind_id, str) and len(kind_id) <= 64 and matches(KIND, kind_id),
            "Expected a namespaced part kind ID.")
    require(anchor in LAYER_ANCHORS, "Unknown layer anchor.")


def validate_rights(rights):
    require(isinstance(rights, dict) and set(rights) == {"basis", "holder", "reference"},
            "Expected rights basis, holder and reference.")
    require(rights["basis"] in ("original", "license", "permission"), "Unknown rights basis.")
    for field, limit in (("holder", 120), ("reference", 240)):
        value = rights[field]
        require(isinstance(value, str) and len(value) <= limit and value == value.strip() and
                all(unicodedata.category(char)[0] != "C" for char in value),
                "Invalid rights text.")
    require(rights["holder"] and (rights["basis"] == "original" or rights["reference"]),
            "A rights holder and applicable license or permission reference are required.")


def validate_source(source):
    require(isinstance(source, dict) and set(source) == {
        "candidate_id", "candidate_sha256", "source_id", "source_sha256", "source_part", "source_frame",
    }, "Invalid cutout provenance.")
    require(matches(ID["sg"], source["candidate_id"]) and matches(ID["cp"], source["source_id"]) and
            matches(SHA256, source["source_sha256"]) and matches(SHA256, source["candidate_sha256"]) and
            source["source_part"] in SOURCE_PARTS and type(source["source_frame"]) is int and
            0 <= source["source_frame"] < FRAMES, "Invalid cutout provenance.")


def verified_png(data, expected_hash, size, limit):
    require(isinstance(data, bytes) and 0 < len(data) <= limit, "Invalid PNG size.")
    require(matches(SHA256, expected_hash) and sha256(data) == expected_hash, "PNG hash mismatch.")
    try:
        with Image.open(io.BytesIO(data), formats=("PNG",)) as image:
            require(image.mode == "RGBA" and image.size == size and
                    image.get_format_mimetype() == "image/png", "Expected a static RGBA PNG of the specified size.")
            image.verify()
        with Image.open(io.BytesIO(data), formats=("PNG",)) as image:
            image.load()
            return image.copy()
    except (OSError, SyntaxError, EOFError, Image.DecompressionBombError) as exc:
        raise PartValidationError("Invalid or damaged PNG.") from exc


def checked_bounds(image, declared):
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    require(bbox is not None and alpha.getextrema()[0] == 0,
            "A part needs visible pixels and transparent background.")
    require(isinstance(declared, list) and len(declared) == 4 and
            all(type(value) is int for value in declared) and
            declared == list(bbox), "Part bounds mismatch.")
    return list(bbox)


def prepare_catalog_part(candidate, png, *, kind_id, layer_anchor, rights):
    """Return a v1 manifest and a six-frame PNG draft without writing files."""
    validate_placement(kind_id, layer_anchor)
    validate_rights(rights)
    require(isinstance(candidate, dict) and type(candidate.get("schema_version")) is int and
            candidate["schema_version"] == 1 and candidate.get("not_registered_in_game") is True,
            "Expected a saved v1 cutout manifest.")
    metadata = candidate.get("metadata")
    require(isinstance(metadata, dict) and metadata.get("review_required") is True and
            type(metadata.get("width")) is int and metadata["width"] == WIDTH and
            type(metadata.get("height")) is int and metadata["height"] == HEIGHT,
            "Expected metadata from a reviewed cutout.")
    source = {
        "candidate_id": candidate.get("candidate_id"),
        "candidate_sha256": candidate.get("part_png_sha256"),
        "source_id": candidate.get("source_id"),
        "source_sha256": candidate.get("source_sha256"),
        "source_part": metadata.get("source_part"),
        "source_frame": metadata.get("frame"),
    }
    validate_source(source)
    cell = verified_png(png, source["candidate_sha256"], (WIDTH, HEIGHT), MAX_CANDIDATE_BYTES)
    bbox = checked_bounds(cell, metadata.get("bbox"))
    atlas = Image.new("RGBA", ATLAS_SIZE)
    for frame in range(FRAMES):
        atlas.paste(cell, (frame * WIDTH, 0))
    output = io.BytesIO()
    atlas.save(output, format="PNG")
    data = output.getvalue()
    require(len(data) <= MAX_ATLAS_BYTES, "Catalog PNG exceeds the size limit.")
    manifest = {
        "schema_version": 1,
        "part_id": "pt_" + uuid.uuid4().hex,
        "kind_id": kind_id,
        "layer_anchor": layer_anchor,
        "rights": dict(rights),
        "source": source,
        "image": {**ATLAS_LAYOUT, "sha256": sha256(data), "bbox": bbox},
    }
    return manifest, data


def validate_catalog_part(manifest, png):
    """Check a detached manifest and its PNG before a future reader uses them."""
    require(isinstance(manifest, dict) and set(manifest) == {
        "schema_version", "part_id", "kind_id", "layer_anchor", "rights", "source", "image",
    } and type(manifest["schema_version"]) is int and manifest["schema_version"] == 1,
            "Unsupported catalog manifest.")
    require(matches(ID["pt"], manifest["part_id"]), "Invalid catalog part ID.")
    validate_placement(manifest["kind_id"], manifest["layer_anchor"])
    validate_rights(manifest["rights"])
    validate_source(manifest["source"])
    image = manifest["image"]
    require(isinstance(image, dict) and set(image) == {*ATLAS_LAYOUT, "sha256", "bbox"} and
            all(type(image[key]) is type(expected) and image[key] == expected
                for key, expected in ATLAS_LAYOUT.items()), "Invalid catalog image layout.")
    atlas = verified_png(png, image["sha256"], ATLAS_SIZE, MAX_ATLAS_BYTES)
    first = atlas.crop((0, 0, WIDTH, HEIGHT))
    checked_bounds(first, image["bbox"])
    sample = first.tobytes()
    for frame in range(1, FRAMES):
        offset = frame * WIDTH
        require(atlas.crop((offset, 0, offset + WIDTH, HEIGHT)).tobytes() == sample,
                "Catalog PNG must repeat the same static cell in all six frames.")

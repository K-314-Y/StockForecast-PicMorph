"""Offline pixel-mask evaluation; no inference, downloads or game integration."""
from __future__ import annotations

import argparse
from io import BytesIO
import json
from pathlib import Path
from time import perf_counter

from PIL import Image, ImageChops, UnidentifiedImageError

if __package__:
    from .adaptive_region import extract_region_adaptive
    from .region_grow import MAX_BYTES, MAX_PIXELS, MAX_SIDE, extract_region
else:
    from adaptive_region import extract_region_adaptive
    from region_grow import MAX_BYTES, MAX_PIXELS, MAX_SIDE, extract_region

PART_COLORS = {"hair": (255, 0, 0), "face": (100, 150, 255),
               "outfit": (180, 0, 255)}


def read_png(path: Path) -> Image.Image:
    """Check compressed size and dimensions before loading pixel data."""
    if not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise ValueError("Input missing or exceeds 8 MiB")
    try:
        with Image.open(path) as image:
            w, h = image.size
            if image.format != "PNG" or getattr(image, "n_frames", 1) != 1:
                raise ValueError("Only single-frame PNG inputs are supported")
            if not (1 <= w <= MAX_SIDE and 1 <= h <= MAX_SIDE
                    and w * h <= MAX_PIXELS):
                raise ValueError("Image exceeds 4096px / 4,000,000 pixel limits")
            image.load()
            return image.copy()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
        raise ValueError("Cannot decode PNG safely") from error


def binary_mask(image: Image.Image) -> Image.Image:
    """L/1 must be binary; RGBA foreground means any nonzero alpha."""
    if image.mode == "RGBA":
        return image.getchannel("A").point(lambda value: 255 if value else 0)
    if image.mode not in ("L", "1"):
        raise ValueError("Binary mask mode must be L, 1 or RGBA")
    result = image.convert("L")
    if any(result.histogram()[1:255]):
        raise ValueError("L mask must contain only binary values 0 and 255")
    return result


def semantic_mask(image: Image.Image, part: str) -> Image.Image:
    if image.mode != "RGB":
        raise ValueError("Semantic label PNG mode must be RGB")
    channels = image.split()
    matches = [channel.point(lambda value, target=target: 255 if value == target else 0)
               for channel, target in zip(channels, PART_COLORS[part])]
    return ImageChops.multiply(ImageChops.multiply(matches[0], matches[1]), matches[2])


def pixel_metrics(truth: Image.Image, prediction: Image.Image) -> dict:
    """Inputs are normalized L masks (0/255). Both empty counts as perfect."""
    if truth.size != prediction.size:
        raise ValueError("Mask dimensions must match; resizing is forbidden")
    tp = ImageChops.multiply(truth, prediction).histogram()[255]
    selected = prediction.histogram()[255]
    expected = truth.histogram()[255]
    fp, fn = selected - tp, expected - tp
    total = truth.width * truth.height
    both_empty = selected == expected == 0
    return {
        "tp": tp, "fp": fp, "fn": fn, "tn": total - tp - fp - fn,
        "iou": tp / (tp + fp + fn) if tp + fp + fn else 1.0,
        "precision": tp / selected if selected else float(both_empty),
        "recall": tp / expected if expected else float(both_empty),
        "f1": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 1.0,
        "coverage": selected / total,
    }


def validate_output(output: Path, inputs: list[Path]) -> None:
    resolved = output.resolve()
    if "local_state" in resolved.parts or "local_state" in output.absolute().parts:
        raise ValueError("Output in local_state is forbidden")
    for source in inputs:
        if resolved == source.resolve() or (output.exists() and output.samefile(source)):
            raise ValueError("Output must not overwrite an input")
    if output.exists() or output.is_symlink():
        raise ValueError("Output already exists; overwriting is forbidden")
    if output.suffix.lower() != ".png" or not output.parent.is_dir():
        raise ValueError("Output needs a .png suffix and an existing parent directory")


class LimitedPNGBuffer(BytesIO):
    def write(self, data: bytes) -> int:
        if self.tell() + len(data) > MAX_BYTES:
            raise ValueError("Output PNG exceeds 8 MiB")
        return super().write(data)


def evaluate(source: Path, truth: Path, *, method: str, prediction: Path | None = None,
             seed_x: int | None = None, seed_y: int | None = None,
             tolerance: int | None = None, part: str | None = None,
             output: Path | None = None, step_tolerance: int | None = None,
             drift_tolerance: int | None = None) -> dict:
    started = perf_counter()
    if method not in ("seeded", "adaptive-seeded", "mask", "anime-seg-rgb"):
        raise ValueError("Unknown method")
    if method in ("seeded", "adaptive-seeded"):
        if seed_x is None or seed_y is None or prediction is not None or part is not None:
            raise ValueError("seeded requires seed-x/seed-y and forbids prediction/part")
    elif prediction is None or any(v is not None for v in (seed_x, seed_y, tolerance)):
        raise ValueError("mask/anime-seg-rgb requires prediction and forbids seed/tolerance")
    if (method == "anime-seg-rgb" and part not in PART_COLORS
            or method != "anime-seg-rgb" and part is not None):
        raise ValueError("part hair/face/outfit is required only for anime-seg-rgb")
    if method != "adaptive-seeded" and any(v is not None for v in (step_tolerance, drift_tolerance)):
        raise ValueError("Adaptive tolerances require adaptive-seeded")
    if method == "adaptive-seeded" and tolerance is not None:
        raise ValueError("adaptive-seeded forbids tolerance")
    inputs = [source, truth] + ([prediction] if prediction is not None else [])
    if output is not None:
        validate_output(output, inputs)
    original = read_png(source)
    truth_image = read_png(truth)
    if truth_image.size != original.size:
        raise ValueError("Truth dimensions must match source; resizing is forbidden")
    expected = binary_mask(truth_image)
    if method in ("seeded", "adaptive-seeded"):
        extraction_started = perf_counter()
        if method == "adaptive-seeded":
            cutout, _ = extract_region_adaptive(original, seed_x, seed_y,
                18 if step_tolerance is None else step_tolerance,
                90 if drift_tolerance is None else drift_tolerance)
        else:
            cutout, _ = extract_region(original, seed_x, seed_y,
                                       35 if tolerance is None else tolerance)
        segmentation_ms = round((perf_counter() - extraction_started) * 1000, 3)
        selected = binary_mask(cutout)
    else:
        predicted_image = read_png(prediction)
        if predicted_image.size != original.size:
            raise ValueError("Prediction dimensions must match source; resizing is forbidden")
        selected = (semantic_mask(predicted_image, part) if method == "anime-seg-rgb"
                    else binary_mask(predicted_image))
    result = {"method": method, "part": part, "same_canvas": list(original.size),
              **pixel_metrics(expected, selected)}
    if method in ("seeded", "adaptive-seeded"):
        result["segmentation_ms"] = segmentation_ms
    result["elapsed_ms"] = round((perf_counter() - started) * 1000, 3)
    if output is not None:
        cutout = Image.new("RGBA", original.size, (0, 0, 0, 0))
        cutout.paste(original.convert("RGBA"), (0, 0), selected)
        with LimitedPNGBuffer() as buffer:
            cutout.save(buffer, format="PNG")
            # Validate again after processing; exclusive creation prevents overwrites.
            validate_output(output, inputs)
            with output.open("xb") as destination:
                try:
                    destination.write(buffer.getvalue())
                except OSError:
                    output.unlink(missing_ok=True)
                    raise
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--truth", type=Path, required=True)
    parser.add_argument("--method", choices=("seeded", "adaptive-seeded", "mask", "anime-seg-rgb"), required=True)
    parser.add_argument("--seed-x", type=int)
    parser.add_argument("--seed-y", type=int)
    parser.add_argument("--tolerance", type=int)
    parser.add_argument("--step-tolerance", type=int)
    parser.add_argument("--drift-tolerance", type=int)
    parser.add_argument("--prediction", type=Path)
    parser.add_argument("--part", choices=tuple(PART_COLORS))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        result = evaluate(**vars(args))
    except (ValueError, OSError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, allow_nan=False, indent=2))


if __name__ == "__main__":
    main()

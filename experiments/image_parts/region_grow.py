"""Small CPU-only prototype: seeded colour region growing for hand-authored art.

This is NOT a semantic hair/face/clothes detector. The human chooses a
foreground seed. A contiguous set of similar-coloured pixels is kept in a
full-size transparent PNG for inspection. Never touches the game's saves.
"""
from __future__ import annotations

import argparse
from collections import deque
from dataclasses import dataclass
from pathlib import Path
import json

from PIL import Image, UnidentifiedImageError

MAX_PIXELS = 4_000_000
MAX_SIDE = 4096
MAX_BYTES = 8 * 1024 * 1024

@dataclass(frozen=True)
class RegionMetrics:
    selected_pixels: int
    total_pixels: int
    coverage: float
    touched_boundary: bool

def extract_region(image: Image.Image, seed_x: int, seed_y: int,
                   tolerance: int = 35, max_coverage: float = 0.70
                   ) -> tuple[Image.Image, RegionMetrics]:
    """Extract a four-connected, seed-colour region into a same-size RGBA image.

    The fixed seed colour prevents walking over long continuous gradients.
    If it floods >max_coverage, we fail rather than pretend a region is correct.
    """
    w, h = image.size
    if not (1 <= w <= MAX_SIDE and 1 <= h <= MAX_SIDE and w * h <= MAX_PIXELS):
        raise ValueError("Image dimensions exceed safe 4096px / four-million-pixel limits")
    if type(seed_x) is not int or type(seed_y) is not int or not (0 <= seed_x < w and 0 <= seed_y < h):
        raise ValueError("The seed pixel must be within the image")
    if type(tolerance) is not int or not (0 <= tolerance <= 255):
        raise ValueError("Colour tolerance must be an integer from 0 to 255")
    if not (0.01 <= max_coverage <= 1.0):
        raise ValueError("max_coverage must be between 0.01 and 1.0")
    rgba = image.convert("RGBA")
    pixels = rgba.load()
    origin = pixels[seed_x, seed_y]
    if origin[3] < 16:
        raise ValueError("The chosen seed is transparent; select a visible pixel")
    # Bytearray avoids a Python set of several million 2-tuples.
    visited = bytearray(w * h)
    mask = Image.new("L", (w, h), 0)
    mask_pixels = mask.load()
    queue = deque([(seed_x, seed_y)])
    limit = int(w * h * max_coverage)
    count = 0
    touched = False
    while queue:
        x, y = queue.popleft()
        pos = y * w + x
        if visited[pos]:
            continue
        visited[pos] = 1
        color = pixels[x, y]
        if color[3] < 16 or max(abs(color[i] - origin[i]) for i in range(3)) > tolerance:
            continue
        count += 1
        if count > limit:
            raise ValueError("Region covers too much of the image; choose a seed or tolerance again")
        mask_pixels[x, y] = 255  # Copy original RGBA unchanged; don't square alpha
        touched = touched or x == 0 or y == 0 or x == w-1 or y == h-1
        if x > 0 and not visited[pos-1]: queue.append((x-1, y))
        if x+1 < w and not visited[pos+1]: queue.append((x+1, y))
        if y > 0 and not visited[pos-w]: queue.append((x, y-1))
        if y+1 < h and not visited[pos+w]: queue.append((x, y+1))
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(rgba, (0, 0), mask)
    return out, RegionMetrics(count, w * h, round(count/(w*h), 6), touched)

def generate(input_file: Path, output_file: Path, *, x: int, y: int, tolerance: int) -> dict:
    if not input_file.is_file() or input_file.stat().st_size > MAX_BYTES:
        raise ValueError("Input missing or exceeds 8 MB")
    if output_file.resolve() == input_file.resolve():
        raise ValueError("Input and output must be different files")
    try:
        with Image.open(input_file) as image:
            if image.format not in ("PNG", "JPEG", "WEBP"):
                raise ValueError("Only PNG/JPEG/WebP images are supported")
            result, stats = extract_region(image, x, y, tolerance)
    except (UnidentifiedImageError, OSError) as error:
        raise ValueError("Cannot decode image") from error
    output_file.parent.mkdir(parents=True, exist_ok=True)
    # Only caller-specified local path; not a Creature Lab save.
    result.save(output_file, format="PNG")
    return {
        "method": "human-seeded-rgb-region-growing",
        "semantic_detection": False,
        "output": str(output_file),
        "coverage": stats.coverage,
        "selected_pixels": stats.selected_pixels,
        "touched_image_boundary": stats.touched_boundary,
        "same_canvas": list(result.size),
    }

def main():
    parser = argparse.ArgumentParser(description="Experimental colour-region cutout; NOT automatic anime parsing")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--x", type=int, required=True, help="Human-chosen seed X in source pixels")
    parser.add_argument("--y", type=int, required=True, help="Human-chosen seed Y in source pixels")
    parser.add_argument("--tolerance", type=int, default=35, help="Max RGB channel difference (0 to 255)")
    args = parser.parse_args()
    print(json.dumps(generate(args.input,args.output,x=args.x,y=args.y,tolerance=args.tolerance),
                     ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()

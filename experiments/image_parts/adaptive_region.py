"""Original local-step, seed-bounded RGB growth; no semantic identification or I/O."""
from collections import deque
import math

from PIL import Image

if __package__:
    from .region_grow import MAX_SIDE, MAX_PIXELS, RegionMetrics
else:
    from region_grow import MAX_SIDE, MAX_PIXELS, RegionMetrics


def extract_region_adaptive(image, seed_x, seed_y, step_tolerance=18,
                            drift_tolerance=90, max_coverage=0.70):
    """Follow four-connected gradients while bounding drift from the seed.

    A failed parent edge does not mark a candidate visited: another accepted
    parent may reach it. Each accepted pixel is queued once. Thin gradual
    colour bridges can still leak into background within the drift bound.
    """
    w, h = image.size
    if not (1 <= w <= MAX_SIDE and 1 <= h <= MAX_SIDE and w * h <= MAX_PIXELS):
        raise ValueError('Image exceeds 4096px / four-million-pixel limits')
    if (type(seed_x) is not int or type(seed_y) is not int
            or not (0 <= seed_x < w and 0 <= seed_y < h)):
        raise ValueError('Seed must be within the image')
    for value in (step_tolerance, drift_tolerance):
        if type(value) is not int or not 0 <= value <= 255:
            raise ValueError('Tolerances must be integers from 0 to 255')
    if (type(max_coverage) not in (int, float) or not math.isfinite(max_coverage)
            or not 0.01 <= max_coverage <= 1):
        raise ValueError('max_coverage must be between 0.01 and 1')
    rgba = image.convert('RGBA')
    pixels = rgba.load()
    origin = pixels[seed_x, seed_y]
    if origin[3] < 16:
        raise ValueError('Seed is transparent')
    visited = bytearray(w * h)
    mask = Image.new('L', (w, h), 0)
    selected = mask.load()
    queue = deque([seed_y * w + seed_x])
    visited[queue[0]] = 1
    count = 1
    limit = int(w * h * max_coverage)
    touched = False
    while queue:
        if count > limit:
            raise ValueError('Region covers too much of the image')
        pos = queue.popleft()
        x, y = pos % w, pos // w
        selected[x, y] = 255
        touched |= x == 0 or y == 0 or x == w - 1 or y == h - 1
        parent = pixels[x, y]
        for nx, ny in ((x-1, y), (x+1, y), (x, y-1), (x, y+1)):
            if not (0 <= nx < w and 0 <= ny < h):
                continue
            index = ny * w + nx
            if visited[index]:
                continue
            color = pixels[nx, ny]
            if (color[3] < 16
                    or max(abs(color[i] - origin[i]) for i in range(3)) > drift_tolerance):
                visited[index] = 1  # These failures are independent of parent.
                continue
            if max(abs(color[i] - parent[i]) for i in range(3)) <= step_tolerance:
                visited[index] = 1
                count += 1
                if count > limit:
                    raise ValueError('Region covers too much of the image')
                queue.append(index)
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    out.paste(rgba, (0, 0), mask)
    return out, RegionMetrics(count, w*h, round(count/(w*h), 6), bool(touched))

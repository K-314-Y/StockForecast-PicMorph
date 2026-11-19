#!/usr/bin/env python3
"""Reproducible raster prototype: split the ORIGINAL six-frame HatchPet idle into body and expression overlays.

Not equivalent to hand-authored Live2D parts. Do not apply to user-uploaded or third-party images.
"""
from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw
import statistics

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "assets/hatchpet-demo-idle.webp"
FRAMES, WIDTH, HEIGHT = 6, 192, 208
MOODS = ("ready", "happy", "cautious")
OUTPUTS = {"body": ROOT / "assets/hatchpet-demo-parts-body.webp"}
OUTPUTS.update({f"face-{mood}": ROOT / f"assets/hatchpet-demo-parts-face-{mood}.webp" for mood in MOODS})

with Image.open(SRC) as opened:
    original = opened.convert("RGBA")
assert original.size == (FRAMES * WIDTH, HEIGHT), original.size

sheets = {key: Image.new("RGBA", original.size, (0, 0, 0, 0)) for key in OUTPUTS}
for i in range(FRAMES):
    frame = original.crop((i * WIDTH, 0, (i + 1) * WIDTH, HEIGHT))
    body = frame.copy()
    # Original chibi face is painted in the raster and cannot be removed automatically.
    # Only blend a small inner area, leaving hair, face perimeter, ears, body untouched.
    sample = [frame.getpixel((x, y))[:3] for x,y in [(95,74),(96,79),(100,79),(95,84),(95,92)]]
    skin = tuple(int(statistics.median(c[k] for c in sample)) for k in range(3))
    # Original face is mostly flat shaded. Use a small bounded patch over eyes/cheeks/mouth.
    # Feather only the 2-pixel perimeter to avoid a sharp rectangle.
    patch = Image.new("RGBA", frame.size, (0,0,0,0))
    mask = Image.new("L", frame.size, 0)
    painter = ImageDraw.Draw(mask)
    painter.rounded_rectangle((65,68,128,111), radius=11, fill=255)
    patch.paste(skin+(255,), (0,0,WIDTH,HEIGHT))
    from PIL import ImageFilter
    mask = mask.filter(ImageFilter.GaussianBlur(1.25))
    body.paste(patch, (0,0), mask)
    sheets["body"].alpha_composite(body, (i * WIDTH, 0))

    for mood in MOODS:
        overlay = Image.new("RGBA", (WIDTH,HEIGHT), (0,0,0,0))
        draw = ImageDraw.Draw(overlay)
        dark=(62,48,88,255)
        mouth=(144,77,104,255)
        pink=(244,139,170,190)
        # Eye and mouth positions are fixed in the image's original 192x208 geometry.
        for x in (79,113):
            if mood=="ready":
                if i in (2,3):
                    draw.arc((x-6,84,x+6,93),0,180,fill=dark,width=3)
                else:
                    draw.ellipse((x-3,84,x+3,94),fill=dark)
            elif mood=="happy":
                draw.arc((x-7,86,x+7,98),180,360,fill=dark,width=3)
            else: # cautious
                draw.ellipse((x-3,86,x+3,94),fill=dark)
                if x<100: draw.line((x-9,83,x+2,85),fill=dark,width=2)
                else: draw.line((x-2,85,x+9,83),fill=dark,width=2)
        draw.ellipse((68,100,80,106),fill=pink)
        draw.ellipse((112,100,124,106),fill=pink)
        if mood=="ready":
            draw.arc((91,98,103,108),0,180,fill=mouth,width=2)
        elif mood=="happy":
            draw.arc((87,96,107,112),0,180,fill=mouth,width=3)
        else:
            draw.arc((92,104,102,110),180,360,fill=mouth,width=2)
        sheets[f"face-{mood}"].alpha_composite(overlay, (i * WIDTH, 0))

for key, path in OUTPUTS.items():
    sheets[key].save(path, "WEBP", lossless=True, method=6)
    with Image.open(path) as verify:
        assert verify.size == original.size
        assert verify.mode=="RGBA"
    print(f"{path.name}: {path.stat().st_size} B")

# Direct visual sanity check only; explicit browser review remains required.
test = Image.alpha_composite(
    sheets["body"].crop((2*WIDTH,0,3*WIDTH,HEIGHT)),
    sheets["face-happy"].crop((2*WIDTH,0,3*WIDTH,HEIGHT)))
test.save(Path("/tmp/creature-s82-composite-happy.png"))

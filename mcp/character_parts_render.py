"""Original chibi artwork drawn from local geometric primitives."""
import math
import random

from PIL import Image, ImageDraw

WIDTH, HEIGHT, FRAMES = 192, 208, 6
SCALE = 3
BOB = (0, -2, -4, -5, -3, -1)
MOODS = ("ready", "happy", "cautious")
INK = "#382d46"
SKIN = "#ffdbb6"
SKIN_SHADE = "#efa789"


def shade(color, toward, amount):
    rgb = bytes.fromhex(color.lstrip("#"))
    return tuple(round(v * (1 - amount) + t * amount) for v, t in zip(rgb, toward))


class Cel:
    def __init__(self, dy):
        self.image = Image.new("RGBA", (WIDTH * SCALE, HEIGHT * SCALE))
        self.pen = ImageDraw.Draw(self.image)
        self.dy = dy

    def points(self, coords):
        return [(round(x * SCALE), round((y + self.dy) * SCALE))
                for x, y in zip(coords[::2], coords[1::2])]

    def ellipse(self, box, color, edge=None, width=2):
        self.pen.ellipse(self.points(box), fill=color, outline=edge, width=width * SCALE)

    def round_rect(self, box, radius, color, edge=None):
        self.pen.rounded_rectangle(self.points(box), radius=radius * SCALE,
                                   fill=color, outline=edge, width=2 * SCALE)

    def line(self, coords, color, width=2):
        self.pen.line(self.points(coords), fill=color, width=width * SCALE, joint="curve")

    def shape(self, coords, color, edge=INK):
        points = self.points(coords)
        self.pen.polygon(points, fill=color)
        if edge:
            self.pen.line(points + points[:1], fill=edge, width=2 * SCALE, joint="curve")

    def arc(self, box, start, end, color, width=2):
        self.pen.arc(self.points(box), start, end, fill=color, width=width * SCALE)

    def finish(self):
        return self.image.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)


def draw_body(dy, hair, coat, accessory, mirrored):
    cel = Cel(dy)
    hair_shadow = shade(hair, (42, 29, 60), .43)
    hair_light = shade(hair, (255, 232, 222), .44)
    coat_shadow = shade(coat, (42, 29, 60), .34)
    coat_light = shade(coat, (255, 248, 226), .65)

    # Hair behind the shoulders, hands, boots and coat.
    cel.round_rect((40, 49, 152, 149), 33, hair_shadow, INK)
    cel.round_rect((66, 158, 92, 188), 10, "#665170", INK)
    cel.round_rect((100, 158, 126, 188), 10, "#665170", INK)
    cel.arc((70, 172, 88, 184), 190, 325, "#b49cb2")
    cel.arc((103, 172, 122, 184), 200, 340, "#b49cb2")
    cel.ellipse((50, 144, 70, 167), SKIN, INK)
    cel.ellipse((122, 144, 142, 167), SKIN, INK)
    cel.round_rect((50, 127, 142, 154), 13, coat_shadow, INK)
    cel.round_rect((62, 123, 130, 174), 16, coat, INK)
    cel.line((96, 144, 96, 172), coat_shadow)
    cel.shape((69, 148, 82, 150, 80, 160, 68, 158), coat_light)
    cel.shape((123, 148, 110, 150, 112, 160, 124, 158), coat_light)
    cel.round_rect((77, 119, 115, 142), 8, coat_light, INK)
    cel.ellipse((92, 139, 100, 147), "#ffd47f", INK)

    cel.ellipse((41, 87, 61, 109), SKIN_SHADE, INK)
    cel.ellipse((131, 87, 151, 109), SKIN_SHADE, INK)
    cel.round_rect((50, 46, 142, 129), 37, SKIN_SHADE, INK)
    cel.round_rect((53, 47, 139, 123), 34, SKIN)
    cel.ellipse((45, 27, 147, 83), hair, INK)
    # The fringe ends above the expression atlas's drawing area.
    fringe = (48, 62, 62, 51, 83, 48, 110, 49, 135, 58, 145, 70,
              145, 93, 137, 98, 132, 85, 131, 73, 113, 79, 103, 69,
              80, 82, 83, 69, 60, 81, 54, 98, 47, 92)
    if mirrored:
        fringe = tuple(192 - v if i % 2 == 0 else v for i, v in enumerate(fringe))
    cel.shape(fringe, hair)
    cel.arc((57, 33, 135, 80), 207, 314, hair_light, 3)
    cel.arc((69, 38, 123, 65), 230, 282, hair_light, 2)
    cel.arc((88, 23, 106, 42), 190, 295, INK, 3)

    if accessory == "ribbon":
        cel.shape((127, 53, 112, 42, 113, 62, 128, 58), "#fa8eae")
        cel.shape((129, 52, 145, 43, 145, 62, 129, 58), "#fa8eae")
        cel.ellipse((123, 50, 134, 61), "#ffd47f", INK)
    if accessory == "star":
        points = []
        for i in range(10):
            angle = i * math.pi / 5 - math.pi / 2
            radius = 12 if i % 2 == 0 else 5
            points.extend((130 + math.cos(angle) * radius, 55 + math.sin(angle) * radius))
        cel.shape(points, "#ffd47f")
    shadow = Cel(0)
    shadow.ellipse((52, 187, 140, 196), (54, 39, 71, 45))
    return Image.alpha_composite(shadow.image, cel.image).resize(
        (WIDTH, HEIGHT), Image.Resampling.LANCZOS)


def draw_face(dy, mood, accessory, blink):
    cel = Cel(dy)
    for x in (71, 121):
        cel.ellipse((x - 6, 104, x + 6, 109), "#f59a9f")
    for x in (77, 115):
        if mood == "happy":
            cel.arc((x - 7, 91, x + 7, 103), 185, 355, INK, 3)
        elif blink:
            cel.arc((x - 7, 91, x + 7, 103), 5, 175, INK, 3)
        else:
            cel.ellipse((x - 5, 91, x + 5, 104), INK)
            cel.ellipse((x - 3, 92, x, 96), "#fff8ed")
        if mood == "cautious":
            outer = -1 if x == 77 else 1
            cel.line((x + 5 * outer, 89, x - 4 * outer, 85), INK)
    if mood == "happy":
        cel.ellipse((88, 107, 104, 119), "#853e5b", INK)
        cel.arc((90, 110, 102, 117), 20, 160, "#fa9eab", 3)
    elif mood == "cautious":
        cel.ellipse((93, 108, 99, 115), "#a35567", INK, 1)
    else:
        cel.arc((90, 104, 102, 114), 14, 166, INK)
    if accessory == "glasses":
        for x in (77, 115):
            cel.round_rect((x - 12, 87, x + 12, 107), 7, None, "#624262")
        cel.line((89, 95, 103, 95), "#624262")
    return cel.finish()


def render(appearance):
    rng = random.Random(appearance["seed"])
    mirrored = rng.choice((False, True))
    layers = {key: Image.new("RGBA", (WIDTH * FRAMES, HEIGHT)) for key in ("body", *MOODS)}
    preview = []
    for i, dy in enumerate(BOB):
        body = draw_body(dy, appearance["hair_color"], appearance["clothing_color"],
                         appearance["accessory"], mirrored)
        layers["body"].paste(body, (i * WIDTH, 0))
        for mood in MOODS:
            face = draw_face(dy, mood, appearance["accessory"], i == 5)
            layers[mood].paste(face, (i * WIDTH, 0))
            if mood == "ready":
                preview.append(Image.alpha_composite(body, face))
    return layers, preview

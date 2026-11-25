"""P9ah research-only forked price fixtures and unmodified P9ag decisions."""
import hashlib
import json
import sys

import accessory_regime_plans as p9ag

SEED = "P9ah-crash-forks-v1"
BRANCHES = ("weak", "stall", "flat", "decline", "double", "mixed")
SETS = ("development", "validation")
COUNT = 60


def family(split, index):
    def draw(key, mod):
        digest = hashlib.sha256(f"{SEED}/{split}/{index}/{key}".encode("ascii")).digest()
        return int.from_bytes(digest, "big") % mod

    def noise(key, amplitude):
        return draw(key, 2 * amplitude + 1) - amplitude

    def close(previous, bps):
        return (previous * (10000 + bps) + 5000) // 10000

    shock = 2 + draw("shock-day", 3)
    prefix = [10900]
    for t in range(shock):
        prefix.append(close(prefix[-1], noise(f"pre-{t}", 80)))
    prefix.append(close(prefix[-1], -900 + noise("shock-size", 80)))
    second = 3 + draw("second-day", 3)
    positive_day = 1 + draw("mix-order", 2)
    paths = {}
    for branch in BRANCHES:
        cents = prefix.copy()
        for k in range(1, 12 - shock):
            prior = cents[-1]
            if branch == "weak":
                drift, amplitude = 35, 90
            elif branch == "stall":
                drift, amplitude = (180 if k <= 2 else -65), 90
            elif branch == "flat":
                drift, amplitude = (prefix[-1] - prior) * 5000 // prior, 60
            elif branch == "decline":
                drift, amplitude = -120, 80
            elif branch == "double":
                drift, amplitude = (-650, 80) if k == second else (40, 110)
            elif k <= 2:  # mixed
                drift, amplitude = (220 if k == positive_day else -160), 100
            else:
                drift, amplitude = 70, 240
            cents.append(close(prior, drift + noise(f"{branch}-{k}", amplitude)))
        paths[branch] = tuple(p / 100 for p in cents[1:])
    return shock, paths


def ai_plans(path):
    return {name: plan for name, plan in p9ag.plans(path)
            if name in ("glasses", "standard", "triple")}


if __name__ == "__main__":
    split, = sys.argv[1:]
    if split not in SETS:
        raise ValueError(split)
    for index in range(COUNT):
        shock, paths = family(split, index)
        print(json.dumps({"index": index, "shock": shock,
                          "branches": {key: ai_plans(path) for key, path in paths.items()}},
                         separators=(",", ":")))

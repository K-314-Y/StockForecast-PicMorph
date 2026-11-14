"""Permission-gated, offline batch scoring. No inference or output files."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import stat
from statistics import mean, median
from time import perf_counter
from urllib.parse import urlsplit

if __package__:
    from .evaluate_masks import (read_png, binary_mask, semantic_mask, pixel_metrics,
                                 PART_COLORS, MAX_BYTES, MAX_SIDE, extract_region)
else:
    from evaluate_masks import (read_png, binary_mask, semantic_mask, pixel_metrics,
                                PART_COLORS, MAX_BYTES, MAX_SIDE, extract_region)

MAX_MANIFEST_BYTES = 128 * 1024
MAX_CASES = 100


def require(condition, message):
    if not condition:
        raise ValueError(message)


def exact_keys(value, keys):
    require(isinstance(value, dict) and set(value) == set(keys),
            "Missing or unexpected manifest keys")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON keys")
        result[key] = value
    return result


def local_png(root, value):
    require(isinstance(value, str) and value and not any(ord(c) < 32 for c in value),
            "Invalid local PNG path")
    require(not any(c in value for c in ("\\", ":", "?", "#")), "Invalid local PNG path")
    path = Path(value)
    require(not path.is_absolute() and all(p not in ("", ".", "..") for p in value.split("/")),
            "Paths must be strictly relative without traversal")
    current = root
    for component in path.parts:
        current = current / component
        info = current.lstat()
        require(not stat.S_ISLNK(info.st_mode), "Symlink inputs are forbidden")
    require(stat.S_ISREG(info.st_mode) and current.suffix.lower() == ".png"
            and info.st_size <= MAX_BYTES, "Input must be a bounded plain PNG file")
    return current


def validate_rights(rights):
    exact_keys(rights, ("basis", "evidence", "local_evaluation_allowed", "redistribution_allowed", "covered_files"))
    require(rights["basis"] in ("self_created", "author_permission", "licensed"),
            "Unrecognized permission basis")
    require(rights["local_evaluation_allowed"] is True and rights["redistribution_allowed"] is False,
            "Local evaluation permission required; redistribution must be disabled")
    evidence = rights["evidence"]
    require(isinstance(evidence, str) and len(evidence.strip()) >= 10 and len(evidence) <= 2048
            and not any(ord(c) < 32 or ord(c) == 127 for c in evidence)
            and not any(c in evidence for c in "<>"), "Descriptive permission evidence required")
    # References are never fetched. Reject executable/non-web URI schemes and malformed URLs.
    for token in evidence.split():
        if ":" in token:
            parsed = urlsplit(token)
            if parsed.scheme:
                require(parsed.scheme == "https" and bool(parsed.hostname)
                        and not parsed.username and not parsed.password,
                        "Evidence URL must be a plain HTTPS reference")


def preflight(manifest):
    manifest = Path(manifest)
    for component in (manifest.absolute(), *manifest.absolute().parents):
        require(not component.is_symlink(), "Symlink manifest paths are forbidden")
    require(stat.S_ISREG(manifest.stat().st_mode), "Manifest must be a plain local file")
    with manifest.open("rb") as stream:
        raw = stream.read(MAX_MANIFEST_BYTES + 1)
    require(len(raw) <= MAX_MANIFEST_BYTES, "Manifest exceeds 128 KiB")
    data = json.loads(raw, object_pairs_hook=unique_object)
    exact_keys(data, ("schema_version", "dataset_type", "cases"))
    require(type(data["schema_version"]) is int and data["schema_version"] == 1,
            "Unsupported schema version")
    require(data["dataset_type"] in ("synthetic_original", "permissioned_art"), "Invalid dataset type")
    cases = data["cases"]
    require(isinstance(cases, list) and 1 <= len(cases) <= MAX_CASES, "Batch needs 1 to 100 cases")
    root = manifest.parent.resolve()
    seen = set()
    validated = []
    for case in cases:
        require(isinstance(case, dict), "Invalid case")
        method = case.get("method")
        require(method in ("seeded", "mask", "anime-seg-rgb"), "Unknown method")
        fields = {"id", "part", "method", "source", "truth", "rights"}
        fields.update(("seed_x", "seed_y", "tolerance") if method == "seeded" else ("prediction",))
        exact_keys(case, fields)
        identifier = case["id"]
        require(isinstance(identifier, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", identifier),
                "Invalid case ID")
        require(identifier not in seen, "Duplicate case ID")
        seen.add(identifier)
        require(case["part"] in PART_COLORS, "Unknown part")
        validate_rights(case["rights"])
        if data["dataset_type"] == "synthetic_original":
            require(case["rights"]["basis"] == "self_created",
                    "Synthetic-original datasets must be declared self-created")
        # The declaration covers original art AND human/predicted derived masks.
        expected_coverage = (["source", "truth"] if method == "seeded"
                             else ["source", "truth", "prediction"])
        require(case["rights"]["covered_files"] == expected_coverage,
                "Permission declaration must explicitly cover all input files")
        if method == "seeded":
            for key, upper in (("seed_x", MAX_SIDE - 1), ("seed_y", MAX_SIDE - 1), ("tolerance", 255)):
                require(type(case[key]) is int and 0 <= case[key] <= upper, "Invalid seeded parameter")
        item = {key: case[key] for key in ("method", "part")}
        for key in ("source", "truth") + (() if method == "seeded" else ("prediction",)):
            item[key] = local_png(root, case[key])
        if method == "seeded":
            item.update({key: case[key] for key in ("seed_x", "seed_y", "tolerance")})
        validated.append(item)
    return data["dataset_type"], validated


def aggregate(cases):
    scored = [case for case in cases if not case["empty_truth"]]
    result = {"count": len(cases), "nonempty_truth_count": len(scored),
              "empty_truth": {"count": len(cases) - len(scored),
                              "both_empty_count": sum(c["empty_truth"] and c["tp"] + c["fp"] == 0 for c in cases),
                              "false_positive_pixels": sum(c["fp"] for c in cases if c["empty_truth"])}}
    for metric in ("iou", "f1"):
        values = [c[metric] for c in scored]
        result[metric] = {"mean": mean(values) if values else None,
                          "median": median(values) if values else None,
                          "min": min(values) if values else None,
                          "worst_cases": [c["id"] for c in sorted(scored, key=lambda c: (c[metric], c["id"]))[:5]]}
    return result


def batch_evaluate(manifest):
    dataset_type, cases = preflight(manifest)  # Complete before any image decoding.
    results = []
    for index, case in enumerate(cases, 1):
        source = read_png(case["source"])
        truth = binary_mask(read_png(case["truth"]))
        require(source.size == truth.size, "Truth dimensions must match source")
        if case["method"] == "seeded":
            cutout, _ = extract_region(source, case["seed_x"], case["seed_y"], case["tolerance"])
            prediction = binary_mask(cutout)
        else:
            image = read_png(case["prediction"])
            prediction = (semantic_mask(image, case["part"]) if case["method"] == "anime-seg-rgb"
                          else binary_mask(image))
        require(source.size == prediction.size, "Prediction dimensions must match source")
        started = perf_counter()
        metrics = pixel_metrics(truth, prediction)
        elapsed = (perf_counter() - started) * 1000
        results.append({"id": f"case_{index:03d}", "method": case["method"], "part": case["part"],
                        "empty_truth": metrics["tp"] + metrics["fn"] == 0,
                        **metrics, "elapsed_ms": round(elapsed, 3)})
    groups = []
    for method, part in sorted({(c["method"], c["part"]) for c in results}):
        groups.append({"method": method, "part": part,
                       **aggregate([c for c in results if (c["method"], c["part"]) == (method, part)])})
    return {"schema_version": 1, "dataset_type": dataset_type,
            "interpretation": ("synthetic_only_not_real_art_accuracy" if dataset_type == "synthetic_original"
                               else "permission_declared_not_legally_verified"),
            "rights_notice": "Rights holder must independently confirm permissions; no legal verification.",
            "score_status": "scored" if any(not c["empty_truth"] for c in results) else "no_nonempty_truth",
            "timing_scope": "pixel_metric_scoring_only_excludes_io_extraction_and_model_inference",
            "elapsed_ms": round(sum(c["elapsed_ms"] for c in results), 3),
            "total": aggregate(results), "groups": groups, "cases": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = batch_evaluate(args.manifest)
    except (ValueError, OSError, TypeError, KeyError, RecursionError):
        # Never echo input filenames, IDs or private permission references, including decode errors.
        print(json.dumps({"error": "Batch rejected: invalid manifest, permission, path or image."}))
        return 2
    print(json.dumps(result, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

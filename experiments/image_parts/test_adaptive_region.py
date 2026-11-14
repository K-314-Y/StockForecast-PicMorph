"""Tests use original Pillow-drawn geometry, never licensed character images."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image, ImageDraw

from adaptive_region import extract_region_adaptive
from region_grow import extract_region
from evaluate_masks import evaluate, binary_mask, pixel_metrics
from batch_evaluate import batch_evaluate, preflight
from prepare_benchmark import prepare


class AdaptiveRegionTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="creature_adaptive_original_")
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.source = self.root / "original.png"
        self.truth = self.root / "truth.png"
        self.prediction = self.root / "prediction.png"
        self.size = (64, 48)
        im = Image.new("RGB", self.size, (245, 245, 245))
        truth = Image.new("L", self.size, 0)
        for x in range(10, 34):
            for y in range(8, 28):
                im.putpixel((x, y), (60 + 3*(x-10), 80 + 2*(x-10), 140))
                truth.putpixel((x, y), 255)
        im.save(self.source)
        truth.save(self.truth)
        truth.save(self.prediction)
        self.seed = (12, 15)

    def gradient_masks(self):
        original = Image.open(self.source)
        truth = binary_mask(Image.open(self.truth))
        fixed, _ = extract_region(original, *self.seed, tolerance=20)
        adaptive, stats = extract_region_adaptive(original, *self.seed,
                                                  step_tolerance=18, drift_tolerance=90)
        return truth, fixed, adaptive, stats

    def test_gradient_improves_fixed_seeded_without_having_truth_as_input(self):
        truth, fixed, adaptive, stats = self.gradient_masks()
        fixed_score = pixel_metrics(truth, binary_mask(fixed))
        adaptive_score = pixel_metrics(truth, binary_mask(adaptive))
        self.assertLess(fixed_score["iou"], 0.5)
        self.assertEqual(adaptive_score["iou"], 1.0)
        self.assertGreater(adaptive_score["iou"], fixed_score["iou"])
        self.assertEqual(stats.selected_pixels, 24 * 20)

    def test_sharp_boundary_stops_at_background(self):
        _, _, adaptive, stats = self.gradient_masks()
        self.assertEqual(adaptive.getpixel((34, 15))[3], 0)
        self.assertEqual(adaptive.getpixel((22, 15))[3], 255)
        self.assertFalse(stats.touched_boundary)

    def test_gradual_bridge_leaks_into_background_and_is_not_semantic(self):
        original = Image.new("RGB", (60, 40), (245, 245, 245))
        truth = Image.new("L", (60, 40), 0)
        for x in range(7, 16):
            for y in range(14, 23):
                original.putpixel((x, y), (80, 80, 80))
                truth.putpixel((x, y), 255)
        for x in range(16, 29):
            for y in range(17, 20):
                v = 80 + 3 * (x - 15)
                original.putpixel((x, y), (v, v, v))
        cut, _ = extract_region_adaptive(original, 9, 18, 18, 90)
        score = pixel_metrics(truth, binary_mask(cut))
        self.assertGreater(score["fp"], 0)
        self.assertLess(score["iou"], 1.0)

    def test_alpha_of_original_selected_pixels_preserved(self):
        original = Image.new("RGBA", (32, 32), (250, 250, 250, 255))
        for y in range(8, 13):
            for x in range(8, 13):
                original.putpixel((x, y), (80, 80, 80, 128))
        cut, _ = extract_region_adaptive(original, 10, 10, 18, 90)
        self.assertEqual(cut.getpixel((10, 10)), (80, 80, 80, 128))
        self.assertEqual(cut.getpixel((7, 7))[3], 0)

    def test_reject_transparent_seed(self):
        original = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
        with self.assertRaises(ValueError):
            extract_region_adaptive(original, 10, 10)

    def test_low_alpha_seed_is_rejected_like_the_fixed_baseline(self):
        original = Image.new("RGBA", (20, 20), (50, 50, 50, 10))
        with self.assertRaises(ValueError):
            extract_region_adaptive(original, 10, 10)

    def test_coverage_guard_on_background_color(self):
        original = Image.new("RGB", (20, 20), (40, 40, 40))
        with self.assertRaises(ValueError):
            extract_region_adaptive(original, 10, 10, max_coverage=.20)

    def test_invalid_seed_and_thresholds(self):
        original = Image.new("RGB", (20, 20), (40, 40, 40))
        for kw in (dict(seed_x=-1), dict(seed_x=20), dict(seed_x=True),
                   dict(seed_y=False), dict(step_tolerance=256),
                   dict(step_tolerance=-1), dict(step_tolerance=True),
                   dict(drift_tolerance=1.5), dict(drift_tolerance=-1),
                   dict(max_coverage=float("nan")), dict(max_coverage=0),
                   dict(max_coverage=1.1)):
            with self.subTest(kw=kw), self.assertRaises(ValueError):
                extract_region_adaptive(original, **dict({"seed_x":10, "seed_y":10}, **kw))

    def test_invalid_image_dimensions(self):
        with self.assertRaises(ValueError):
            extract_region_adaptive(Image.new("RGB", (0, 20)), 0, 0)

    def test_evaluate_cli_adaptive_and_explicit_png(self):
        result = evaluate(self.source, self.truth, method="adaptive-seeded",
                          seed_x=12, seed_y=15,
                          step_tolerance=18, drift_tolerance=90,
                          output=self.root / "adaptive_out.png")
        self.assertEqual(result["iou"], 1)
        self.assertEqual(result["same_canvas"], [64, 48])
        self.assertGreaterEqual(result["segmentation_ms"], 0)
        with Image.open(self.root / "adaptive_out.png") as im:
            self.assertEqual(im.size, self.size)
            self.assertEqual(im.convert("RGBA").getpixel((34, 15))[3], 0)

    def test_evaluate_does_not_overwrite_input_or_output(self):
        out = self.root / "saved.png"
        out.write_bytes(b"reserved")
        for path in (out, self.source, self.truth):
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                evaluate(self.source, self.truth, method="adaptive-seeded",
                         seed_x=12, seed_y=15, output=path)
            self.assertEqual(path.read_bytes(), before)

    def test_evaluate_rejects_cross_method_arguments(self):
        for kw in (dict(tolerance=20), dict(prediction=self.prediction),
                   dict(part="hair"), dict(seed_x=True),
                   dict(drift_tolerance=256)):
            with self.subTest(kw=kw), self.assertRaises(ValueError):
                evaluate(self.source, self.truth, method="adaptive-seeded",
                         **dict({"seed_x":12, "seed_y":15}, **kw))
        with self.assertRaises(ValueError):
            evaluate(self.source, self.truth, method="mask",
                     prediction=self.prediction, step_tolerance=18)

    def rights(self):
        return {"basis":"self_created",
                "evidence":"Original synthetic gradient rectangle and all masks were made locally",
                "local_evaluation_allowed":True,
                "redistribution_allowed":False,
                "covered_files":["source", "truth"]}

    def manifest(self, **overrides):
        case = {"id":"hair_adaptive", "part":"hair", "method":"adaptive-seeded",
                "source":"original.png", "truth":"truth.png",
                "seed_x":12, "seed_y":15, "step_tolerance":18,
                "drift_tolerance":90,"rights":self.rights()}
        case.update(overrides)
        path = self.root / "private_manifest.json"
        path.write_text(json.dumps({"schema_version":1,
                        "dataset_type":"synthetic_original","cases":[case]}))
        return path

    def test_strict_permissioned_manifest_valid_and_scores(self):
        p = self.manifest()
        _, cases = preflight(p)
        self.assertEqual(len(cases), 1)
        summary = batch_evaluate(p)
        self.assertEqual(summary["total"]["iou"]["mean"], 1)
        self.assertEqual(summary["cases"][0]["method"], "adaptive-seeded")
        self.assertGreaterEqual(summary["cases"][0]["segmentation_ms"], 0)

    def test_preflight_rejects_wrong_rights_or_extra_field(self):
        for kwargs in ({"prediction":"prediction.png"},
                       {"tolerance":20},
                       {"step_tolerance":True},
                       {"step_tolerance":256},
                       {"drift_tolerance":-1},
                       {"rights":dict(self.rights(),covered_files=["source"])}):
            with self.subTest(kwargs=kwargs):
                p = self.manifest(**kwargs)
                with self.assertRaises(ValueError):
                    preflight(p)

    def test_prepare_opt_in_adds_same_seed_twice_and_evaluates(self):
        n, skipped = prepare(folder=str(self.root),source="original.png",
            hair_truth="truth.png",basis="self_created",
            evidence="Original synthetic gradient rectangle, locally drawn for test",
            dataset_type="synthetic_original", tolerance=20,
            confirm_local_evaluation=True,output="paired.json",
            adaptive=True,step_tolerance=18,drift_tolerance=90)
        self.assertEqual((n,skipped),(2,[]))
        payload=json.loads((self.root/"paired.json").read_text())
        a,b=payload["cases"]
        self.assertEqual([a["method"],b["method"]],["seeded","adaptive-seeded"])
        self.assertEqual((a["seed_x"],a["seed_y"]),(b["seed_x"],b["seed_y"]))
        output=batch_evaluate(self.root/"paired.json")
        fixed_group = next(g for g in output["groups"] if g["method"]=="seeded")
        self.assertLess(fixed_group["iou"]["mean"],1)
        adaptive_group=next(g for g in output["groups"] if g["method"]=="adaptive-seeded")
        self.assertEqual(adaptive_group["iou"]["mean"],1)

    def test_prepare_opt_out_preserves_original_case_count(self):
        n,_=prepare(folder=str(self.root),source="original.png",
            hair_truth="truth.png",basis="self_created",
            evidence="Original synthetic gradient rectangle, locally drawn for test",
            dataset_type="synthetic_original", tolerance=20,
            confirm_local_evaluation=True,output="original.json")
        self.assertEqual(n,1)
        payload=json.loads((self.root/"original.json").read_text())
        self.assertEqual(payload["cases"][0]["method"],"seeded")


if __name__=="__main__":
    unittest.main()

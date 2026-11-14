import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

from evaluate_masks import (MAX_BYTES, LimitedPNGBuffer, PART_COLORS, evaluate,
                            main, validate_output)


class EvaluateMasksTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source.png"
        self.truth = self.root / "truth.png"
        self.prediction = self.root / "prediction.png"
        self.output = self.root / "output.png"
        Image.new("RGBA", (4, 3), (30, 40, 50, 128)).save(self.source)
        self.save_mask(self.truth, {0, 1, 4, 5})
        self.save_mask(self.prediction, {0, 1, 4, 5})

    def save_mask(self, path, selected, mode="L"):
        image = Image.new("L", (4, 3))
        image.putdata([255 if i in selected else 0 for i in range(12)])
        image.convert(mode).save(path)

    def run_mask(self, **kwargs):
        return evaluate(self.source, self.truth, method="mask",
                        prediction=self.prediction, **kwargs)

    def test_perfect_mask(self):
        result = self.run_mask()
        self.assertEqual([result[k] for k in ("tp", "fp", "fn", "tn")], [4, 0, 0, 8])
        for key in ("iou", "precision", "recall", "f1"):
            self.assertEqual(result[key], 1.0)
        self.assertEqual(result["coverage"], 1 / 3)
        self.assertGreaterEqual(result["elapsed_ms"], 0)
        self.assertFalse(self.output.exists())

    def test_seed_leaks_into_connected_same_color_region(self):
        image = Image.new("RGB", (4, 3), "white")
        for index in (0, 1, 2, 4, 5, 6):
            image.putpixel((index % 4, index // 4), (200, 0, 0))
        image.save(self.source)
        result = evaluate(self.source, self.truth, method="seeded",
                          seed_x=0, seed_y=0, tolerance=0)
        self.assertEqual([result[k] for k in ("tp", "fp", "fn", "tn")], [4, 2, 0, 6])
        self.assertAlmostEqual(result["iou"], 2 / 3)
        self.assertEqual(result["f1"], 0.8)

    def test_three_semantic_parts_and_exact_matching(self):
        image = Image.new("RGB", (4, 3), "black")
        for index, (part, color) in enumerate(PART_COLORS.items()):
            image.putpixel((index, 0), color)
        image.putpixel((3, 0), (254, 0, 0))  # Almost red is not hair.
        image.save(self.prediction)
        for index, part in enumerate(PART_COLORS):
            with self.subTest(part=part):
                self.save_mask(self.truth, {index})
                result = evaluate(self.source, self.truth, method="anime-seg-rgb",
                                  prediction=self.prediction, part=part)
                self.assertEqual(result["tp"], 1)
                self.assertEqual(result["fp"], 0)
                self.assertEqual(result["iou"], 1.0)

    def test_wrong_dimensions_for_truth_and_prediction(self):
        for path in (self.truth, self.prediction):
            with self.subTest(path=path):
                Image.new("L", (3, 4)).save(path)  # Same area, wrong shape.
                with self.assertRaisesRegex(ValueError, "dimensions"):
                    self.run_mask(output=self.output)
                self.assertFalse(self.output.exists())
                self.save_mask(path, {0, 1, 4, 5})

    def test_empty_masks_and_zero_division(self):
        for expected, predicted, score in ((set(), set(), 1.0), ({0}, set(), 0.0),
                                           (set(), {0}, 0.0)):
            with self.subTest(expected=expected, predicted=predicted):
                self.save_mask(self.truth, expected)
                self.save_mask(self.prediction, predicted)
                result = self.run_mask()
                for key in ("iou", "precision", "recall", "f1"):
                    self.assertEqual(result[key], score)

    def test_partial_overlap(self):
        self.save_mask(self.prediction, {1, 2, 5, 6})
        result = self.run_mask()
        self.assertEqual([result[k] for k in ("tp", "fp", "fn", "tn")], [2, 2, 2, 6])
        self.assertAlmostEqual(result["iou"], 1 / 3)
        self.assertEqual(result["precision"], 0.5)
        self.assertEqual(result["recall"], 0.5)
        self.assertEqual(result["f1"], 0.5)

    def test_output_retains_original_alpha_and_canvas(self):
        before = self.source.read_bytes()
        self.run_mask(output=self.output)
        with Image.open(self.output) as image:
            self.assertEqual(image.size, (4, 3))
            self.assertEqual(image.mode, "RGBA")
            self.assertEqual(image.getpixel((0, 0)), (30, 40, 50, 128))
            self.assertEqual(image.getpixel((3, 2)), (0, 0, 0, 0))
        self.assertEqual(self.source.read_bytes(), before)

    def test_binary_one_and_rgba_alpha(self):
        self.save_mask(self.truth, {0}, "1")
        image = Image.new("RGBA", (4, 3), (255, 255, 255, 0))
        image.putpixel((0, 0), (0, 0, 0, 1))
        image.save(self.prediction)
        self.assertEqual(self.run_mask()["iou"], 1.0)

    def test_input_overwrite_and_hardlink_rejected(self):
        for path in (self.source, self.truth, self.prediction):
            with self.subTest(path=path):
                with self.assertRaisesRegex(ValueError, "overwrite"):
                    self.run_mask(output=path)
        self.output.hardlink_to(self.source)
        with self.assertRaisesRegex(ValueError, "overwrite"):
            self.run_mask(output=self.output)

    def test_invalid_binary_modes_and_gray_values(self):
        for mode in ("RGB", "P", "L"):
            with self.subTest(mode=mode):
                Image.new(mode, (4, 3), 100).save(self.prediction)
                with self.assertRaisesRegex(ValueError, "mode|binary"):
                    self.run_mask()

    def test_invalid_semantic_mode(self):
        with self.assertRaisesRegex(ValueError, "RGB"):
            evaluate(self.source, self.truth, method="anime-seg-rgb",
                     prediction=self.prediction, part="hair")

    def test_output_safety_and_no_implicit_directories(self):
        for output in (self.root / "local_state" / "x.png",
                       self.root / "missing" / "x.png", self.root / "x.jpg"):
            with self.subTest(output=output):
                with self.assertRaises(ValueError):
                    self.run_mask(output=output)
                self.assertFalse(output.parent.exists() and output.exists())
        self.assertFalse((self.root / "missing").exists())
        self.output.write_bytes(b"keep")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.run_mask(output=self.output)
        self.assertEqual(self.output.read_bytes(), b"keep")

    def test_symlink_output_safety(self):
        self.output.symlink_to(self.source)
        with self.assertRaisesRegex(ValueError, "overwrite"):
            self.run_mask(output=self.output)
        self.output.unlink()
        protected = self.root / "local_state"
        protected.mkdir()
        alias = self.root / "alias"
        alias.symlink_to(protected, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "local_state"):
            validate_output(alias / "out.png", [self.source])
        self.assertEqual(list(protected.iterdir()), [])

    def test_dimensions_and_compressed_input_limit(self):
        for size in ((4097, 1), (2001, 2000)):
            with self.subTest(size=size):
                Image.new("1", size).save(self.prediction)
                with self.assertRaisesRegex(ValueError, "limits"):
                    self.run_mask()
        with self.prediction.open("wb") as file:
            file.truncate(MAX_BYTES + 1)
        with self.assertRaisesRegex(ValueError, "8 MiB"):
            self.run_mask()

    def test_output_encoded_size_limit(self):
        with LimitedPNGBuffer() as buffer:
            buffer.seek(MAX_BYTES)
            with self.assertRaisesRegex(ValueError, "8 MiB"):
                buffer.write(b"x")
        with patch("evaluate_masks.MAX_BYTES", 100):
            # Inputs fit 100 bytes, but force encoder failure before file creation.
            with patch.object(LimitedPNGBuffer, "write", side_effect=ValueError("8 MiB")):
                with self.assertRaisesRegex(ValueError, "8 MiB"):
                    self.run_mask(output=self.output)
        self.assertFalse(self.output.exists())

    def test_method_specific_arguments(self):
        invalid = [dict(method="seeded"), dict(method="mask"),
                   dict(method="mask", prediction=self.prediction, seed_x=0),
                   dict(method="mask", prediction=self.prediction, tolerance=0),
                   dict(method="mask", prediction=self.prediction, part="hair"),
                   dict(method="anime-seg-rgb", prediction=self.prediction),
                   dict(method="seeded", seed_x=0, seed_y=0, prediction=self.prediction),
                   dict(method="seeded", seed_x=-1, seed_y=0),
                   dict(method="seeded", seed_x=0, seed_y=0, tolerance=256)]
        for args in invalid:
            with self.subTest(args=args), self.assertRaises(ValueError):
                evaluate(self.source, self.truth, **args)

    def test_non_png_and_corrupt_input(self):
        Image.new("RGB", (4, 3)).save(self.prediction, format="JPEG")
        with self.assertRaisesRegex(ValueError, "PNG"):
            self.run_mask()
        self.prediction.write_bytes(b"not an image")
        with self.assertRaisesRegex(ValueError, "decode"):
            self.run_mask()

    def test_cli_json_and_failure(self):
        args = ["evaluate_masks", "--source", str(self.source), "--truth", str(self.truth),
                "--method", "mask", "--prediction", str(self.prediction)]
        stdout = io.StringIO()
        with patch.object(sys, "argv", args), contextlib.redirect_stdout(stdout):
            main()
        self.assertEqual(json.loads(stdout.getvalue())["iou"], 1.0)
        with patch.object(sys, "argv", args + ["--seed-x", "0"]), \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            main()
        self.assertEqual(error.exception.code, 2)


if __name__ == "__main__":
    unittest.main()

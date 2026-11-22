import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from PIL import Image, ImageDraw

from mcp.independent_parts import PartValidationError, prepare_catalog_part, validate_catalog_part


ROOT = Path(__file__).resolve().parents[1]
RIGHTS = {"basis": "original", "holder": "テスト作者", "reference": ""}
OPTIONS = {"kind_id": "test.paper-flower", "layer_anchor": "face", "rights": RIGHTS}


def encode(image):
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def fixture():
    cell = Image.new("RGBA", (192, 208))
    ImageDraw.Draw(cell).rectangle((30, 40, 39, 47), fill=(255, 60, 80, 130))
    png = encode(cell)
    manifest = {
        "schema_version": 1, "candidate_id": "sg_" + "a" * 32,
        "source_id": "cp_" + "b" * 32, "source_sha256": "c" * 64,
        "part_png_sha256": hashlib.sha256(png).hexdigest(), "not_registered_in_game": True,
        "metadata": {"frame": 4, "source_part": "happy", "width": 192, "height": 208,
                     "bbox": [30, 40, 40, 48], "review_required": True},
    }
    return manifest, png, cell


class IndependentPartTests(unittest.TestCase):
    def test_round_trip_preserves_exact_cells_and_input(self):
        source, png, cell = fixture()
        source_before = copy.deepcopy(source)
        manifest, atlas_png = prepare_catalog_part(source, png, **OPTIONS)
        validate_catalog_part(json.loads(json.dumps(manifest)), atlas_png)
        self.assertEqual(source, source_before)
        self.assertRegex(manifest["part_id"], r"^pt_[0-9a-f]{32}$")
        self.assertEqual(manifest["kind_id"], "test.paper-flower")
        self.assertEqual(manifest["layer_anchor"], "face")
        self.assertEqual(manifest["rights"], RIGHTS)
        self.assertIsNot(manifest["rights"], RIGHTS)
        self.assertEqual(manifest["source"]["source_frame"], 4)
        self.assertEqual(manifest["source"]["candidate_sha256"], source["part_png_sha256"])
        self.assertEqual(manifest["image"]["bbox"], [30, 40, 40, 48])
        with Image.open(io.BytesIO(atlas_png)) as atlas:
            self.assertEqual(atlas.size, (1152, 208))
            for left in range(0, 1152, 192):
                self.assertEqual(atlas.crop((left, 0, left + 192, 208)).tobytes(), cell.tobytes())

    def test_rejects_unreviewed_input_invalid_roots_and_missing_rights(self):
        source, png, _ = fixture()
        for changes in ({"candidate_id": "../candidate"}, {"schema_version": True},
                        {"not_registered_in_game": False}, {"metadata": {"review_required": False}}):
            with self.subTest(changes=changes), self.assertRaises(PartValidationError):
                prepare_catalog_part({**source, **changes}, png, **OPTIONS)
        for changes in ({"kind_id": "../../ribbon"}, {"layer_anchor": "ribbon"},
                        {"rights": {**RIGHTS, "basis": "license"}},
                        {"rights": {**RIGHTS, "holder": "two\nlines"}}):
            with self.subTest(changes=changes), self.assertRaises(PartValidationError):
                prepare_catalog_part(source, png, **{**OPTIONS, **changes})

    def test_rejects_altered_png_invalid_dimensions_and_full_opacity(self):
        source, png, cell = fixture()
        with self.assertRaisesRegex(PartValidationError, "hash mismatch"):
            prepare_catalog_part(source, png[:-1], **OPTIONS)
        corrupt = bytearray(png)
        corrupt[png.index(b"IDAT") + 4] ^= 1
        animated = io.BytesIO()
        cell.save(animated, format="PNG", save_all=True, append_images=[Image.new("RGBA", cell.size)])
        for invalid in (b"not PNG", bytes(corrupt), animated.getvalue(), encode(Image.new("RGBA", (191, 208))),
                        encode(Image.new("RGBA", (192, 208), (1, 2, 3, 255))),
                        encode(Image.new("RGBA", (192, 208)))):
            with self.subTest(size=len(invalid)), self.assertRaises(PartValidationError):
                prepare_catalog_part({**source, "part_png_sha256": hashlib.sha256(invalid).hexdigest()},
                                     invalid, **OPTIONS)

    def test_catalog_reader_rejects_bad_schema_and_inconsistent_frames(self):
        source, png, _ = fixture()
        manifest, atlas_png = prepare_catalog_part(source, png, **OPTIONS)
        with self.assertRaisesRegex(PartValidationError, "Unsupported"):
            validate_catalog_part({**manifest, "schema_version": 2}, atlas_png)
        for changes in ({"filename": "../part.png"}, {"frame_mode": "animated"}, {"frames": 6.0}):
            with self.subTest(changes=changes), self.assertRaisesRegex(PartValidationError, "layout"):
                validate_catalog_part({**manifest, "image": {**manifest["image"], **changes}}, atlas_png)
        with Image.open(io.BytesIO(atlas_png)) as atlas:
            atlas.putpixel((192 + 30, 40), (1, 2, 3, 130))
            modified = encode(atlas)
        with self.assertRaisesRegex(PartValidationError, "hash mismatch"):
            validate_catalog_part(manifest, modified)
        manifest["image"]["sha256"] = hashlib.sha256(modified).hexdigest()
        with self.assertRaisesRegex(PartValidationError, "same static cell"):
            validate_catalog_part(manifest, modified)

    @unittest.skipUnless(sys.platform == "linux", "The existing cutout helper uses Linux storage")
    def test_prepares_a_real_reviewed_save_in_an_isolated_store(self):
        with tempfile.TemporaryDirectory(prefix="creature-independent-part-") as tmp:
            root = Path(tmp)
            helper = root / "mcp"
            helper.mkdir()
            for name in ("artwork_segment.py", "character_parts.py", "segment_onnx.py"):
                shutil.copyfile(ROOT / name, helper / name)
            atlas = Image.new("RGBA", (1152, 208))
            ImageDraw.Draw(atlas).rectangle((192 * 4 + 30, 40, 192 * 4 + 39, 47),
                                           fill=(255, 60, 80, 130))
            payload = {"mode": "preview", "generated_id": "cp_" + "b" * 32, "source_part": "happy",
                       "part_type": "ribbon", "frame": 4, "seeds": [{"x": 31, "y": 42}], "tolerance": 4,
                       "source_png": base64.b64encode(encode(atlas)).decode("ascii")}

            def segment(request):
                response = subprocess.run(
                    [sys.executable, "-B", "-E", str(helper / "artwork_segment.py")],
                    cwd=root, env={"PATH": os.defpath}, input=json.dumps(request) + "\n",
                    text=True, capture_output=True, check=True, timeout=10,
                )
                return json.loads(response.stdout)

            preview = segment(payload)["result"]
            self.assertFalse((root / "local_state").exists())
            payload.update(mode="save", expected_sha256=preview["source_sha256"])
            self.assertIn("error", segment(payload))
            self.assertFalse((root / "local_state").exists())
            payload["review"] = {"sha256": preview["part_png_sha256"], "method": preview["method"]}
            saved = segment(payload)["result"]
            self.assertRegex(saved["candidate_id"], r"^sg_[0-9a-f]{32}$")
            folder = root / "local_state" / "segment_candidates" / saved["candidate_id"]
            cutout_png = (folder / "part.png").read_bytes()
            cutout_manifest = (folder / "manifest.json").read_bytes()
            before = sorted(path.relative_to(root) for path in root.rglob("*"))
            draft, draft_png = prepare_catalog_part(json.loads(cutout_manifest), cutout_png, **OPTIONS)
            validate_catalog_part(draft, draft_png)
            self.assertEqual(sorted(path.relative_to(root) for path in root.rglob("*")), before)
            self.assertEqual((folder / "part.png").read_bytes(), cutout_png)
            self.assertEqual((folder / "manifest.json").read_bytes(), cutout_manifest)

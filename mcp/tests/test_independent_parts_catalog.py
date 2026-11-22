import base64
from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import UUID

from PIL import Image, ImageDraw

MCP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MCP))
import artwork_segment as segment
import import_png_character as importer
import independent_parts_catalog as catalog
from independent_parts import PartValidationError, sha256


def encode(image):
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


@unittest.skipUnless(sys.platform == "linux", "Linux catalog storage")
class IndependentCatalogTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="creature-catalog-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.catalog = self.root / "local_state" / catalog.CATALOG
        root_patch = patch.object(catalog, "ROOT", self.root)
        root_patch.start()
        self.addCleanup(root_patch.stop)
        atlas = Image.new("RGBA", (1152, 208))
        draw = ImageDraw.Draw(atlas)
        for frame in range(6):
            draw.rectangle((frame * 192 + 10 + frame, 20, frame * 192 + 30, 35), fill=(60, 120, 220, 255))
        original = encode(atlas)
        with patch.object(importer, "ROOT", self.root):
            result = importer.register({"name": "Fixture", "parts": {
                role: base64.b64encode(original).decode() for role in segment.SOURCE_PARTS
            }})
        self.source_id = result["generated_id"]
        self.character = self.root / "local_state" / "character_parts" / self.source_id
        request = {"generated_id": self.source_id, "source_part": "happy", "part_type": "ribbon",
                   "frame": 3, "seeds": [{"x": 21, "y": 26}], "tolerance": 0}
        with patch.object(segment, "ROOT", self.root), patch.object(segment, "try_mask", return_value=(None, None)):
            png, metadata = segment.extract(request, original)
            saved = segment.save(request, png, metadata, sha256(original), sha256(png))
        self.candidate = self.root / saved["local_directory"]
        self.args = {"candidate_id": saved["candidate_id"], "expected_candidate_sha256": sha256(png),
                     "kind_id": "creator.ribbon", "layer_anchor": "face",
                     "rights": {"basis": "original", "holder": "作成者", "reference": ""}}

    def install_cli(self):
        script_dir = self.root / "mcp"
        script_dir.mkdir()
        for name in ("independent_parts_catalog.py", "independent_parts.py", "character_parts.py", "import_png_character.py"):
            shutil.copyfile(MCP / name, script_dir / name)
        return script_dir / "independent_parts_catalog.py"

    def cli(self, script, operation, args):
        result = subprocess.run([sys.executable, "-B", "-E", str(script), operation],
                                input=json.dumps(args) + "\n", text=True, capture_output=True,
                                check=True, timeout=10, cwd=self.root)
        return json.loads(result.stdout)

    def update_candidate(self, **changes):
        path = self.candidate / "manifest.json"
        manifest = json.loads(path.read_bytes())
        path.write_text(json.dumps({**manifest, **changes}), encoding="utf-8")

    def test_cli_register_list_and_validate_leave_originals_unchanged(self):
        script = self.install_cli()
        before = {path: path.read_bytes() for folder in (self.character, self.candidate) for path in folder.iterdir()}
        self.assertEqual(self.cli(script, "list", {}), {"result": {"parts": []}})
        self.assertFalse(self.catalog.exists())
        self.assertIn("error", self.cli(script, "validate", {"part_id": "pt_" + "a" * 32}))
        saved = self.cli(script, "register", self.args)["result"]
        self.assertRegex(saved["part_id"], r"^pt_[0-9a-f]{32}$")
        folder = self.catalog / saved["part_id"]
        self.assertEqual(folder.stat().st_mode & 0o777, 0o700)
        self.assertEqual((folder / "part.png").stat().st_mode & 0o777, 0o600)
        self.assertEqual(sha256((folder / "part.png").read_bytes()), saved["image_sha256"])
        self.assertEqual(self.cli(script, "list", {}), {"result": {"parts": [saved]}})
        self.assertEqual(self.cli(script, "validate", {"part_id": saved["part_id"]}), {"result": saved})
        self.assertEqual({path: path.read_bytes() for path in before}, before)
        self.assertEqual({p.name for p in self.catalog.iterdir()}, {saved["part_id"]})
        self.assertFalse((self.root / "local_state" / "node_game").exists())

    def test_bad_arguments_and_unsaved_candidates_do_not_create_catalog(self):
        for changes in ({"candidate_id": "../fixture"}, {"path": "/tmp/anywhere"}, {"kind_id": "ribbon"},
                        {"rights": {**self.args["rights"], "holder": "bad\ntext"}},
                        {"rights": {**self.args["rights"], "basis": "license"}},
                        {"expected_candidate_sha256": "0" * 64}):
            with self.subTest(changes=changes), self.assertRaises(PartValidationError):
                catalog.run("register", {**self.args, **changes})
        self.update_candidate(not_registered_in_game=False)
        with self.assertRaisesRegex(PartValidationError, "saved v1"):
            catalog.run("register", self.args)
        self.assertFalse(self.catalog.exists())

    def test_cli_image_only_returns_valid_selected_png(self):
        script = self.install_cli()
        saved = catalog.run("register", self.args)
        identifier = saved["part_id"]
        request = {"part_id": identifier}
        png = self.catalog / identifier / "part.png"
        image = self.cli(script, "image", request)["result"]
        self.assertEqual(set(image), {"part_id", "image_sha256", "png_base64"})
        self.assertEqual(base64.b64decode(image["png_base64"], validate=True), png.read_bytes())
        self.assertEqual(image["image_sha256"], saved["image_sha256"])
        self.assertNotIn("png_base64", json.dumps(self.cli(script, "list", {})))
        for invalid in ({"part_id": "../bad"}, {**request, "path": str(png)}):
            self.assertNotIn("result", self.cli(script, "image", invalid))
        self.assertEqual(self.cli(script, "image", {"part_id": "pt_" + "0" * 32})["code"], "not_found")
        target = png.with_name("original.png")
        png.rename(target)
        png.symlink_to(target)
        self.assertNotIn("result", self.cli(script, "image", request))
        png.unlink()
        target.rename(png)
        png.write_bytes(b"invalid PNG")
        self.assertNotIn("result", self.cli(script, "image", request))

    def test_modified_cutout_and_source_hashes_fail_closed(self):
        candidate_png = self.candidate / "part.png"
        cutout = candidate_png.read_bytes()
        candidate_png.write_bytes(cutout + b"change")
        with self.assertRaisesRegex(PartValidationError, "PNG hash mismatch"):
            catalog.run("register", self.args)
        candidate_png.write_bytes(cutout)
        source = self.character / "character_happy_6frames.png"
        original = source.read_bytes()
        source.write_bytes(original + b"change")
        with self.assertRaisesRegex(PartValidationError, "manifest check"):
            catalog.run("register", self.args)
        source.write_bytes(original)
        self.update_candidate(source_sha256="0" * 64)
        with self.assertRaisesRegex(PartValidationError, "PNG hash mismatch"):
            catalog.run("register", self.args)
        self.assertFalse(self.catalog.exists())

    def test_unsupported_png_and_forged_pixels_even_with_matching_cutout_hash(self):
        rgba = Image.new("RGBA", (192, 208))
        ImageDraw.Draw(rgba).rectangle((13, 20, 30, 35), fill=(255, 0, 0, 255))
        for data, message in ((encode(rgba.convert("RGB")), "static RGBA"),
                              (encode(rgba), "recorded source frame")):
            (self.candidate / "part.png").write_bytes(data)
            self.update_candidate(part_png_sha256=sha256(data))
            with self.subTest(message=message), self.assertRaisesRegex(PartValidationError, message):
                catalog.run("register", {**self.args, "expected_candidate_sha256": sha256(data)})
        self.assertFalse(self.catalog.exists())

    def test_links_and_unsafe_directories_are_rejected(self):
        png = self.candidate / "part.png"
        aside = png.with_name("aside.png")
        png.rename(aside)
        png.symlink_to(aside)
        with self.assertRaises(OSError):
            catalog.run("register", self.args)
        png.unlink()
        aside.rename(png)
        moved = self.candidate.with_name("moved")
        self.candidate.rename(moved)
        self.candidate.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(OSError):
            catalog.run("register", self.args)
        self.candidate.unlink()
        moved.rename(self.candidate)
        self.catalog.symlink_to(self.character, target_is_directory=True)
        with self.assertRaises(OSError):
            catalog.run("list", {})
        with self.assertRaises(OSError):
            catalog.run("register", self.args)
        self.assertFalse((self.character / "part.png").exists())

    def test_only_registration_reclaims_its_private_staging(self):
        staging = self.catalog / catalog.STAGING
        self.catalog.mkdir(mode=0o700)
        staging.mkdir(mode=0o700)
        unexpected = staging / "unexpected"
        unexpected.write_text("keep", encoding="utf-8")
        self.assertEqual(catalog.run("list", {}), {"parts": []})
        with self.assertRaisesRegex(PartValidationError, "Unexpected file"):
            catalog.run("register", self.args)
        self.assertEqual(unexpected.read_text(), "keep")
        unexpected.unlink()
        interrupted = staging / ".tmp-part.png"
        interrupted.symlink_to(self.candidate / "part.png")
        with self.assertRaisesRegex(catalog.PartsError, "Unsafe temporary"):
            catalog.run("register", self.args)
        interrupted.unlink()
        interrupted.touch(mode=0o600)
        saved = catalog.run("register", self.args)
        self.assertEqual({p.name for p in self.catalog.iterdir()}, {saved["part_id"]})

    def test_input_replaced_between_staging_and_publish_is_rejected(self):
        original_publish = catalog.publish
        path = self.candidate / "manifest.json"
        original = path.read_bytes()

        def publish_and_replace(folder, name, data, limit):
            original_publish(folder, name, data, limit)
            if name == "manifest.json":
                replacement = path.with_name("replacement")
                replacement.touch(mode=0o600)
                replacement.write_bytes(original)
                replacement.replace(path)

        with patch.object(catalog, "publish", side_effect=publish_and_replace):
            with self.assertRaisesRegex(PartValidationError, "file moved or changed"):
                catalog.run("register", self.args)
        self.assertEqual(list(self.catalog.iterdir()), [])

    def test_catalog_replacement_after_staging_cannot_publish_into_either_directory(self):
        original_publish = catalog.publish
        moved = self.catalog.with_name("moved-catalog")

        def publish_and_move(folder, name, data, limit):
            original_publish(folder, name, data, limit)
            if name == "manifest.json":
                self.catalog.rename(moved)
                self.catalog.mkdir(mode=0o700)

        with patch.object(catalog, "publish", side_effect=publish_and_move):
            with self.assertRaisesRegex(PartValidationError, "directory moved or changed"):
                catalog.run("register", self.args)
        self.assertEqual(list(self.catalog.iterdir()), [])
        self.assertEqual(list(moved.iterdir()), [])

    def test_duplicate_destination_id_never_replaces_saved_artifacts(self):
        with patch("independent_parts.uuid.uuid4", return_value=UUID(int=23)):
            saved = catalog.run("register", self.args)
            folder = self.catalog / saved["part_id"]
            previous = {path: path.read_bytes() for path in folder.iterdir()}
            with self.assertRaises(FileExistsError):
                catalog.run("register", {**self.args, "kind_id": "creator.different"})
        self.assertEqual({path: path.read_bytes() for path in previous}, previous)
        self.assertEqual([p.name for p in self.catalog.iterdir()], [saved["part_id"]])

    def test_corrupt_entry_and_capacity(self):
        saved = catalog.run("register", self.args)
        (self.catalog / saved["part_id"] / "part.png").write_bytes(b"damaged")
        for operation, args in (("list", {}), ("validate", {"part_id": saved["part_id"]})):
            with self.assertRaisesRegex(PartValidationError, "PNG hash mismatch"):
                catalog.run(operation, args)
        for i in range(catalog.MAX_PARTS - 1):
            (self.catalog / f"pt_{i:032x}").mkdir(mode=0o700)
        with self.assertRaisesRegex(PartValidationError, "catalog is full"):
            catalog.run("register", self.args)
        self.assertEqual(len(list(self.catalog.iterdir())), catalog.MAX_PARTS)

    def test_two_processes_save_independent_entries_or_return_busy(self):
        script = self.install_cli()
        self.catalog.mkdir(mode=0o700)
        with catalog.directory(self.catalog) as locked:
            catalog.lock(locked, catalog.fcntl.LOCK_EX)
            self.assertIn("busy", self.cli(script, "register", self.args)["error"])
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: self.cli(script, "register", self.args), range(2)))
        for i, response in enumerate(responses):
            if "error" in response:
                self.assertIn("busy", response["error"])
                responses[i] = self.cli(script, "register", self.args)
        ids = {response["result"]["part_id"] for response in responses}
        self.assertEqual(len(ids), 2)
        self.assertEqual({p.name for p in self.catalog.iterdir()}, ids)

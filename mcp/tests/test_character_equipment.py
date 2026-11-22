from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

MCP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MCP))
import character_equipment as store
from independent_parts import PartValidationError


@unittest.skipUnless(sys.platform == "linux", "Linux equipment store")
class CharacterEquipmentTests(unittest.TestCase):
    def setUp(self):
        fixture = tempfile.TemporaryDirectory(prefix="equipment-test-")
        self.addCleanup(fixture.cleanup)
        self.root = Path(fixture.name)
        root = patch.object(store, "ROOT", self.root)
        root.start()
        self.addCleanup(root.stop)
        self.state = self.root / "local_state"
        self.state.mkdir(mode=0o700)
        self.folder = self.state / store.STORE
        self.id = "cp_" + "a" * 32
        self.file = self.folder / (self.id + ".json")
        self.part = {"part_id": "pt_" + "b" * 32, "image_sha256": "c" * 64, "layer_anchor": "face",
                     "x": -24, "y": 24, "visible": False}
        self.args = {"character_id": self.id, "expected_revision": 0, "parts": [self.part]}

    def test_initial_read_does_not_create_and_save_preserves_order_and_other_characters(self):
        self.assertEqual(store.run("read", {"character_id": self.id}),
                         {"schema": 1, "character_id": self.id, "revision": 0, "parts": []})
        self.assertFalse(self.folder.exists())
        second = {**self.part, "part_id": "pt_" + "d" * 32, "visible": True}
        saved = store.run("save", {**self.args, "parts": [second, self.part]})
        self.assertEqual(saved["parts"], [second, self.part])
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.folder.stat().st_mode & 0o777, 0o700)
        self.assertEqual(store.run("read", {"character_id": self.id}), saved)
        other = "cp_" + "e" * 32
        self.assertEqual(store.run("read", {"character_id": other})["revision"], 0)
        with self.assertRaises(store.Conflict):
            store.run("save", self.args)
        cleared = store.run("save", {**self.args, "expected_revision": 1, "parts": []})
        self.assertEqual((cleared["revision"], cleared["parts"]), (2, []))
        self.assertEqual(list(self.folder.iterdir()), [self.file])

    def test_invalid_fields_ids_order_limits_and_revision(self):
        bad_parts = [[{**self.part, **changed}] for changed in (
            {"x": 25}, {"y": True}, {"x": 1.5}, {"visible": 1}, {"image_sha256": "1"},
            {"layer_anchor": "background"}, {"part_id": "../asset"}, {"file": "hidden"},
        )]
        for changed in ([{"parts": parts} for parts in bad_parts + [[self.part]*2, [self.part]*9]] +
                        [{"character_id": "../state"}, {"expected_revision": True}, {"expected_revision": -1}]):
            with self.subTest(changed=changed), self.assertRaises(PartValidationError):
                store.run("save", {**self.args, **changed})
        self.assertFalse(self.folder.exists())

    def test_no_symlink_hardlink_or_corrupt_file_reads_or_writes(self):
        store.run("save", self.args)
        saved = self.file.read_bytes()
        real = self.folder / "synthetic"
        self.file.rename(real)
        self.file.symlink_to(real)
        with self.assertRaises(OSError):
            store.run("read", {"character_id": self.id})
        self.file.unlink()
        os.link(real, self.file)
        with self.assertRaises(PartValidationError):
            store.run("save", {**self.args, "expected_revision": 1})
        self.assertEqual(real.read_bytes(), saved)
        self.file.unlink()
        real.rename(self.file)
        self.file.write_text('{"schema":1}')
        with self.assertRaises(PartValidationError):
            store.run("read", {"character_id": self.id})
        moved = self.state / "moved"
        self.folder.rename(moved)
        self.folder.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(OSError):
            store.run("save", self.args)

    def test_failed_atomic_replace_keeps_previous_bytes_and_cleans_staging(self):
        store.run("save", self.args)
        before = self.file.read_bytes()
        with patch.object(store.os, "replace", side_effect=OSError("simulated")):
            with self.assertRaises(OSError):
                store.run("save", {**self.args, "expected_revision": 1, "parts": []})
        self.assertEqual(self.file.read_bytes(), before)
        self.assertEqual(list(self.folder.iterdir()), [self.file])

    def test_storage_capacity_does_not_prevent_existing_updates(self):
        store.run("save", self.args)
        for i in range(store.MAX_RECORDS - 1):
            (self.folder / f"cp_{i:032x}.json").touch(mode=0o600)
        with self.assertRaisesRegex(PartValidationError, "full"):
            store.run("save", {**self.args, "character_id": "cp_" + "f" * 32})
        self.assertEqual(store.run("save", {**self.args, "expected_revision": 1})["revision"], 2)

    def test_cli_processes_with_the_same_revision_get_one_save_and_one_conflict(self):
        scripts = self.root / "mcp"
        scripts.mkdir()
        for name in ("character_equipment.py", "character_parts.py", "independent_parts.py",
                     "independent_parts_catalog.py", "import_png_character.py"):
            shutil.copyfile(MCP / name, scripts / name)

        def save(_):
            reply = subprocess.run([sys.executable, "-B", "-E", str(scripts / "character_equipment.py"), "save"],
                                   text=True, input=json.dumps(self.args) + "\n", capture_output=True,
                                   cwd=self.root, check=True, timeout=10)
            return json.loads(reply.stdout)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(save, range(2)))
        self.assertEqual([item["code"] for item in results if "code" in item], ["conflict"])
        self.assertEqual([item["result"]["revision"] for item in results if "result" in item], [1])
        self.assertEqual(list(self.folder.iterdir()), [self.file])

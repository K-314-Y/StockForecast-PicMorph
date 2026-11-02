"""Saved practice model bridge tests: no real local_state touched."""
import json
import tempfile
import unittest
from pathlib import Path

import blueprints
import training_lab
from game_runtime.trained_bridge import resolve_version


class SavedPracticeBrainTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_draft, self.old_trained = blueprints.STORE_FILE, training_lab.STORE_FILE
        root = Path(self.temp.name)
        blueprints.STORE_FILE = root / "created_blueprints.json"
        training_lab.STORE_FILE = root / "trained_versions.json"

    def tearDown(self):
        blueprints.STORE_FILE, training_lab.STORE_FILE = self.old_draft, self.old_trained
        self.temp.cleanup()

    def make_version(self):
        draft = blueprints.create_draft({
            "action": "save", "name": "テストキャラ", "concept": "", "style": "",
            "trait": "cautious", "candidate_id": "trend"
        })["draft"]
        version = training_lab.train_save({"draft_id": draft["id"]})["version"]
        return draft, version

    def test_saved_version_loads_its_actual_fitted_parameters(self):
        draft, version = self.make_version()
        result = resolve_version(version["id"])
        self.assertEqual(result["source_draft_id"], draft["id"])
        self.assertEqual(result["parameters_sha256"], version["parameters_sha256"])
        self.assertEqual(result["kind"], "trained_practice_only")
        self.assertEqual(training_lab.digest(result["model"]), version["parameters_sha256"])
        self.assertNotEqual(result["model"]["plugin_weights"],
                            draft["blueprint"]["engine_parameters"]["plugin_weights"])

    def test_invalid_id_and_missing_version_do_not_create_or_change_records(self):
        self.assertRaises(ValueError, resolve_version, "../../etc/passwd")
        self.assertRaises(ValueError, resolve_version, "tv_" + "a" * 32)
        self.assertFalse(training_lab.STORE_FILE.exists())
        self.assertFalse(blueprints.STORE_FILE.exists())

    def test_tampered_version_and_changed_draft_are_rejected(self):
        draft, version = self.make_version()
        data = json.loads(training_lab.STORE_FILE.read_text())
        data["versions"][0]["engine_parameters"]["plugin_weights"]["trend"] = 999
        training_lab.STORE_FILE.write_text(json.dumps(data))
        with self.assertRaises((ValueError, blueprints.BlueprintError)):
            resolve_version(version["id"])

    def test_source_draft_changed_after_training_is_rejected(self):
        draft, version = self.make_version()
        data = json.loads(blueprints.STORE_FILE.read_text())
        data["drafts"][0]["user_declared"]["name"] = "改ざん"
        blueprints.STORE_FILE.write_text(json.dumps(data))
        with self.assertRaises((ValueError, blueprints.BlueprintError)):
            resolve_version(version["id"])


if __name__ == "__main__":
    unittest.main()

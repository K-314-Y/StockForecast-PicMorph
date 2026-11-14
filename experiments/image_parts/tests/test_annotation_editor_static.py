"""Standalone annotation editor contract checks; Chromium handles pixel-level behavior."""
from html.parser import HTMLParser
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
PAGE = (ROOT / "annotate.html").read_text(encoding="utf-8")
SCRIPT = (ROOT / "annotate.js").read_text(encoding="utf-8")


class Tags(HTMLParser):
    def __init__(self):
        super().__init__()
        self.elements = []
    def handle_starttag(self, tag, attrs):
        self.elements.append((tag, dict(attrs)))


def tag_by_id(id_):
    for tag, attributes in TAGS.elements:
        if attributes.get("id") == id_:
            return tag, attributes
    raise AssertionError(f"Missing element {id_}")


TAGS = Tags()
TAGS.feed(PAGE)


class AnnotationEditorContract(unittest.TestCase):
    def test_japanese_standalone_doctype(self):
        self.assertTrue(PAGE.lstrip().lower().startswith("<!doctype html>"))
        self.assertIn('<html lang="ja">', PAGE)

    def test_csp_disallows_network_connections(self):
        self.assertIn("connect-src 'none'", PAGE)
        self.assertIn("default-src 'none'", PAGE)
        self.assertIn("object-src 'none'", PAGE)
        self.assertIn("form-action 'none'", PAGE)

    def test_only_local_script(self):
        script_tags = [attrs for tag, attrs in TAGS.elements if tag == "script"]
        self.assertEqual(len(script_tags), 1)
        self.assertEqual(script_tags[0].get("src"), "annotate.js")
        self.assertNotIn("https://", PAGE)
        self.assertNotIn("http://", PAGE)

    def test_input_is_locked_before_permission(self):
        self.assertEqual(tag_by_id("rights")[1].get("type"), "checkbox")
        tag, attributes = tag_by_id("source")
        self.assertEqual(tag, "input")
        self.assertEqual(attributes.get("type"), "file")
        self.assertIn("image/png", attributes["accept"])
        self.assertIn("disabled", attributes)

    def test_editor_tools_disabled_until_image_loaded(self):
        self.assertEqual(tag_by_id("tools")[0], "fieldset")
        self.assertIn("disabled", tag_by_id("tools")[1])

    def test_all_three_parts_have_save_buttons(self):
        saves = {attrs.get("data-save") for tag, attrs in TAGS.elements if "data-save" in attrs}
        self.assertEqual(saves, {"hair", "face", "outfit"})

    def test_canvas_and_pointer_input(self):
        self.assertEqual(tag_by_id("editor")[0], "canvas")
        for action in ("pointerdown", "pointermove", "pointerup", "pointercancel"):
            self.assertIn(action, SCRIPT)
        self.assertIn("touch-action: none", PAGE)

    def test_brush_radius_and_eraser(self):
        _, radius = tag_by_id("radius")
        self.assertEqual(radius.get("min"), "2")
        self.assertEqual(radius.get("max"), "70")
        self.assertIn("clearRect(left, py", SCRIPT)
        self.assertIn("fillRect(left, py", SCRIPT)
        self.assertEqual(tag_by_id("erase")[1].get("type"), "checkbox")

    def test_image_dimension_and_byte_limits(self):
        for limit in ("8 * 1024 * 1024", "4096", "4_000_000"):
            self.assertIn(limit, SCRIPT)
        self.assertIn("new DataView", SCRIPT)
        self.assertIn("validatePNG(file)", SCRIPT)
        self.assertIn("image.naturalWidth", SCRIPT)

    def test_mask_pixel_coordinates_not_css_coordinates(self):
        self.assertIn("getBoundingClientRect()", SCRIPT)
        self.assertRegex(SCRIPT, r"canvas\.width\s*/\s*rect\.width")
        self.assertRegex(SCRIPT, r"canvas\.height\s*/\s*rect\.height")

    def test_undo_history_memory_bounded(self):
        self.assertIn("32 * 1024 * 1024", SCRIPT)
        self.assertIn("historyBytes + bytes > UNDO_BUDGET", SCRIPT)
        self.assertIn("MAX_UNDO", SCRIPT)
        self.assertIn("putImageData(entry.data", SCRIPT)

    def test_export_is_manual_and_downloads_png(self):
        self.assertIn("masks[part].toBlob(", SCRIPT)
        self.assertIn("'image/png'", SCRIPT)
        self.assertIn("link.download", SCRIPT)
        self.assertIn("window.confirm(", SCRIPT)
        self.assertIn("URL.createObjectURL", SCRIPT)

    def test_no_network_apis_persistence_or_remote_services(self):
        for banned in ("fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "localStorage",
                       "sessionStorage", "indexedDB", "serviceWorker", "document.cookie"):
            self.assertNotIn(banned, SCRIPT)
        self.assertNotIn("https://", SCRIPT)
        self.assertNotIn("http://", SCRIPT)

    def test_rights_notice_and_no_semantic_ai_claim(self):
        self.assertIn("許可", PAGE)
        self.assertIn("正解マスクにも", PAGE)
        self.assertIn("AI画像認識は行いません", PAGE)

    def test_unsaved_changes_require_confirmation_before_replacement(self):
        self.assertIn("history.length && !window.confirm(", SCRIPT)
        self.assertIn("現在の塗り分けを保持しています", SCRIPT)

    def test_editor_readiness_signal_for_offline_smoke(self):
        self.assertIn("document.documentElement.dataset.editorReady = 'true'", SCRIPT)

    def test_no_automatic_file_load_or_upload(self):
        self.assertIn("$('source').addEventListener('change'", SCRIPT)
        self.assertIn("file.arrayBuffer()", SCRIPT)
        self.assertNotIn("<form", PAGE)

if __name__ == "__main__":
    unittest.main()

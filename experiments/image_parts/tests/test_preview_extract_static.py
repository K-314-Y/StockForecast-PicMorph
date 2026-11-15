"""Offline prediction-only UI contract; does not examine user artwork."""
from pathlib import Path
import re
import unittest
from html.parser import HTMLParser

ROOT = Path(__file__).resolve().parents[1]
PAGE = (ROOT / "preview_extract.html").read_text(encoding="utf-8")
SCRIPT = (ROOT / "preview_extract.js").read_text(encoding="utf-8")


class Tags(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = []
    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))


TAGS = Tags()
TAGS.feed(PAGE)


def tagged(id_):
    return next((tag, attrs) for tag, attrs in TAGS.tags if attrs.get("id") == id_)


class PredictionPreviewStaticTests(unittest.TestCase):
    def test_standalone_japanese_ui(self):
        self.assertTrue(PAGE.lstrip().lower().startswith("<!doctype html>"))
        self.assertIn('<html lang="ja">', PAGE)
        self.assertIn("予測マスクを試す", PAGE)

    def test_csp_network_disabled(self):
        for value in ("default-src 'none'", "connect-src 'none'",
                      "object-src 'none'", "worker-src 'none'", "script-src 'self'"):
            self.assertIn(value, PAGE)

    def test_local_script_only(self):
        scripts = [t for t, a in TAGS.tags if t == "script"]
        self.assertEqual(len(scripts), 1)
        self.assertIn('src="preview_extract.js"', PAGE)
        for term in ("http://", "https://", "cdn.", "npmjs.com"):
            self.assertNotIn(term, PAGE)

    def test_no_network_or_browser_persistence(self):
        for forbidden in ("fetch(", "XMLHttpRequest", "WebSocket",
                          "sendBeacon", "localStorage", "sessionStorage",
                          "indexedDB", "serviceWorker"):
            self.assertNotIn(forbidden, SCRIPT)

    def test_no_truth_mask_input_or_gold_editor_modification(self):
        self.assertEqual(sum(1 for t, a in TAGS.tags if t == "input" and a.get("type") == "file"), 1)
        self.assertEqual(tagged("source")[1].get("accept"), ".png,image/png")
        self.assertNotIn('id="truth"', PAGE)
        self.assertNotIn('id="mask"', PAGE)
        self.assertIn("annotate.html", PAGE)

    def test_rights_gate_for_source(self):
        self.assertEqual(tagged("rights")[1].get("type"), "checkbox")
        self.assertIn("disabled", tagged("source")[1])
        self.assertIn("!rights.checked", SCRIPT)

    def test_processing_and_export_are_distinct_actions(self):
        self.assertEqual(tagged("export")[0], "button")
        self.assertIn("disabled", tagged("export")[1])
        self.assertIn('save.addEventListener("click"', SCRIPT)
        self.assertIn("window.confirm(", SCRIPT)
        self.assertIn("link.download", SCRIPT)

    def test_saved_png_is_prediction_not_gold(self):
        self.assertIn("PREDICTION / GUESS", PAGE)
        self.assertIn("label leakage", PAGE)
        self.assertIn("creature_prediction_", SCRIPT)
        self.assertIn("正解として自己評価に使用しない", SCRIPT)

    def test_fixed_and_adaptive_models_available(self):
        self.assertIn('value="seeded"', PAGE)
        self.assertIn('value="adaptive-seeded"', PAGE)
        self.assertIn('method === "adaptive-seeded"', SCRIPT)

    def test_max_image_size_and_cpu_guard(self):
        for phrase in ("8 * 1024 * 1024", "4096", "4_000_000", "2_000_000",
                       "MAX_MS", "15_000"):
            self.assertIn(phrase, SCRIPT)

    def test_png_signature_and_apng_checks(self):
        for phrase in ("IHDR", "IDAT", "IEND", "acTL", "fcTL", "fdAT"):
            self.assertIn(phrase, SCRIPT)
        self.assertIn("new DataView(", SCRIPT)

    def test_native_canvas_coordinate_mapping(self):
        self.assertIn("getBoundingClientRect()", SCRIPT)
        self.assertRegex(SCRIPT, r"\(clientX - rect\.left\) \* width / rect\.width")
        self.assertRegex(SCRIPT, r"\(clientY - rect\.top\) \* height / rect\.height")

    def test_memory_bounded_flood_fill(self):
        self.assertIn("new Uint8Array(total)", SCRIPT)
        self.assertIn("new Uint32Array(total)", SCRIPT)
        self.assertIn("const MAX_COVERAGE = 0.70", SCRIPT)
        self.assertNotIn("queue.shift()", SCRIPT)
        self.assertIn("const CHUNK = 15_000", SCRIPT)

    def test_rgba_white_binary_mask(self):
        self.assertIn("new Uint8ClampedArray(selected.length * 4)", SCRIPT)
        self.assertIn("output.set([255,255,255,255]", SCRIPT)
        self.assertIn('output.toBlob(resolve, "image/png")', SCRIPT)

    def test_stale_results_revoked_on_changed_conditions(self):
        self.assertIn("token++", SCRIPT)
        self.assertIn("if (!alive())", SCRIPT)
        self.assertIn("invalidate(", SCRIPT)
        self.assertIn("current !== token", SCRIPT)

    def test_original_and_inference_are_local_only(self):
        self.assertIn("ctx.getImageData(0, 0", SCRIPT)
        self.assertIn("ctx.putImageData(overlay, 0, 0)", SCRIPT)
        self.assertIn("保存", PAGE)
        self.assertNotIn("AIによる意味的な髪・顔・服の識別です", PAGE)


if __name__ == "__main__":
    unittest.main()

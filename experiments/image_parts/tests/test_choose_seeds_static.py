"""Static privacy and protocol checks; browser interaction tested separately."""
from pathlib import Path
import unittest

root = Path(__file__).resolve().parents[1]
page = (root/'choose_seeds.html').read_text(encoding='utf8')
script = (root/'choose_seeds.js').read_text(encoding='utf8')


class ChooseSeedsStatic(unittest.TestCase):
    def test_japanese_standalone_page(self):
        self.assertIn('<html lang="ja">',page)
        self.assertIn('元PNG',page)

    def test_csp_does_not_allow_connect(self):
        for token in ("default-src 'none'","connect-src 'none'","object-src 'none'","form-action 'none'"):
            self.assertIn(token,page)

    def test_no_external_script_or_background_network(self):
        self.assertIn('src="choose_seeds.js"',page)
        self.assertNotIn('http://',page)
        self.assertNotIn('https://',page)
        for token in ('fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon',
                      'localStorage', 'indexedDB', 'serviceWorker'):
            self.assertNotIn(token,script)

    def test_no_mask_file_input(self):
        self.assertEqual(page.count('type="file"'),1)
        self.assertIn('id="source"',page)
        self.assertNotIn('id="truth"',page)
        self.assertNotIn('id="prediction"',page)

    def test_rights_gate(self):
        self.assertIn('id="rights" type="checkbox"',page)
        self.assertIn("!$('rights').checked",script)
        self.assertIn('id="source" type="file" accept=".png,image/png" disabled',page)

    def test_image_bounds_and_png_validation(self):
        for value in ('8 * 1024 * 1024','4096','4_000_000','new DataView','image.naturalWidth'):
            self.assertIn(value,script)
        self.assertIn('アニメーションPNG',script)

    def test_pixel_coordinates_use_canvas_and_css_rect(self):
        self.assertIn('getBoundingClientRect()',script)
        self.assertIn('data.width / rect.width',script)
        self.assertIn('data.height / rect.height',script)
        self.assertIn('Math.floor',script)

    def test_digest_and_self_reporting(self):
        self.assertIn("crypto.subtle.digest('SHA-256'",script)
        self.assertIn('自己申告',page)
        self.assertIn('正解マスクを見る前',script)

    def test_save_manual_only_not_automatic(self):
        self.assertIn("$('save').addEventListener('click'",script)
        self.assertIn('window.confirm(',script)
        self.assertIn('link.download',script)
        self.assertIn('schema_version: 1',script)
        self.assertIn("points: {hair: null, face: null, outfit: null}",script)

    def test_no_local_image_upload_or_truth_required(self):
        self.assertIn('file.arrayBuffer()',script)
        self.assertIn('data.points',script)
        self.assertIn('画像や権利確認文はJSONに含めません',page)


if __name__=='__main__':
    unittest.main()

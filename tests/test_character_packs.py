import hashlib
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from PIL import Image
import app
import character_packs as packs
from tests import test_blueprints as fixtures


class PackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root/'sample.png'
        image = Image.new('RGBA', (4, 3), (90, 120, 180, 128))
        image.putpixel((0, 0), (0, 0, 0, 0))
        image.save(self.source)
        self.before = self.source.read_bytes()
        self.output = self.root/'pack'

    def test_deterministic_roundtrip_alpha_and_isolation(self):
        state = app.snapshot()
        manifest = packs.convert(self.source, self.output)
        other = self.root/'other'
        packs.convert(self.source, other)
        self.assertEqual(manifest['source']['sha256'], hashlib.sha256(self.before).hexdigest())
        self.assertEqual(manifest['source']['kind'], 'image')
        self.assertEqual(manifest['layers'][0]['slot'], 'unclassified')
        self.assertEqual(len(manifest['layers']), 1)
        for path in self.output.rglob('*'):
            if path.is_file():
                self.assertEqual(path.read_bytes(), (other/path.relative_to(self.output)).read_bytes())
                if path.suffix == '.png':
                    with Image.open(path) as img:
                        self.assertEqual(img.mode, 'RGBA')
                        self.assertEqual(img.size, (4, 3))
                        self.assertEqual(img.getpixel((1, 1))[3], 128)
        for mode in ('fallback', 'layers'):
            _, image = packs.load_pack(self.output, mode)
            self.assertEqual(image.getpixel((1, 1)), (90, 120, 180, 128))
            self.assertEqual(image.getpixel((0, 0)), (0, 0, 0, 0))
        self.assertEqual(self.source.read_bytes(), self.before)
        self.assertEqual(app.snapshot(), state)
        self.assertFalse((self.root/'local_state').exists())
        self.assertFalse((self.output/'source.psd').exists())

    def test_input_bounds_and_cleanup(self):
        for value in ('https://example.invalid/a.png', self.root/'missing'):
            with self.assertRaises(packs.PackError): packs.convert(value, self.output)
        for data in (b'bad', self.before[:30]):
            self.source.write_bytes(data)
            with self.assertRaises(packs.PackError): packs.convert(self.source, self.output)
        self.source.write_bytes(self.before)
        for target, limit in [('MAX_SOURCE', 1), ('MAX_OUTPUT', 1), ('MAX_SIDE', 2)]:
            with patch.object(packs, target, limit), self.assertRaises(packs.PackError):
                packs.convert(self.source, self.output)
            self.assertFalse(self.output.exists())
            self.assertEqual(list(self.root.glob('.pack-*')), [])
        big = Image.new('L', (4097, 1)); big.save(self.source)
        with self.assertRaises(packs.PackError): packs.convert(self.source, self.output)

    def test_new_directory_symlinks_and_failure(self):
        packs.convert(self.source, self.output)
        before = (self.output/'manifest.json').read_bytes()
        with self.assertRaises(packs.PackError): packs.convert(self.source, self.output)
        self.assertEqual((self.output/'manifest.json').read_bytes(), before)
        link = self.root/'link'; link.symlink_to(self.source)
        with self.assertRaises(packs.PackError): packs.convert(link, self.root/'new')
        folder = self.root/'folder'; folder.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(packs.PackError): packs.convert(self.source, folder/'new')
        with patch.object(packs, '_publish_new', side_effect=OSError('failure')):
            with self.assertRaises(packs.PackError): packs.convert(self.source, self.root/'new')
        self.assertFalse((self.root/'new').exists())
        self.assertEqual(list(self.root.glob('.new-*')), [])
        # A destination created after staging must also survive intact.
        def race(stage, output):
            output.mkdir()
            return publish(stage, output)
        publish = packs._publish_new
        with patch.object(packs, '_publish_new', side_effect=race):
            with self.assertRaises(packs.PackError): packs.convert(self.source, self.root/'racing')
        self.assertTrue((self.root/'racing').is_dir())
        self.assertEqual(list((self.root/'racing').iterdir()), [])

    def test_reimport_rejects_dangerous_manifest_and_assets(self):
        m = packs.convert(self.source, self.output)
        for path in ('../evil.png', '/tmp/a.png', 'parts/../original.png', 'parts/a/b.png', 'original.png', 'parts/a.svg', 'parts/a%2e.png', 'parts/a\\b.png'):
            bad = json.loads(json.dumps(m)); bad['layers'][0]['path'] = path
            with self.assertRaises(packs.PackError): packs.validate_manifest(bad)
        for change in ({'manifest_version': True}, {'layers': m['layers']*65}, {'mode_default': 'both'}, {'canvas': {'width': 4097, 'height': 1}}):
            with self.assertRaises(packs.PackError): packs.validate_manifest(m | change)
        asset = self.output/'parts/layer_00.png'
        Image.new('RGBA', (1, 1)).save(asset)
        with self.assertRaises(packs.PackError): packs.load_pack(self.output)
        asset.unlink(); asset.symlink_to(self.source)
        with self.assertRaises(packs.PackError): packs.load_pack(self.output)

    def psd_bytes(self, width=4, height=3):
        return b'8BPS\x00\x01'+b'\0'*6+struct.pack('>HIIHH', 4, height, width, 8, 3)

    def test_psd_optional_absence_and_header_bounds(self):
        self.source = self.root/'source.psd'
        self.source.write_bytes(self.psd_bytes())
        with patch.dict(sys.modules, {'psd_tools': None}), self.assertRaisesRegex(packs.PackError, 'optional psd-tools'):
            packs.convert(self.source, self.output)
        self.source.write_bytes(self.psd_bytes(width=4097))
        with patch.dict(sys.modules, {'psd_tools': None}), self.assertRaisesRegex(packs.PackError, '4096'):
            packs.convert(self.source, self.output)
        self.assertFalse(self.output.exists())

    def test_fake_psd_offset_group_flatten_and_warning(self):
        class Layer:
            blend_mode = b'norm'
            clipping = False
            bbox = (1, 1, 3, 2)
            def is_group(self): return False
            def is_visible(self): return True
            def composite(self): return Image.new('RGBA', (2, 1), (255, 0, 0, 128))
        class Group(Layer):
            def is_group(self): return True
            def __iter__(self): return iter([Layer()])
        class PSD:
            size = (4, 3)
            def __iter__(self): return iter([Group()])
            def composite(self): return Image.new('RGBA', self.size)
        module = types.SimpleNamespace(PSDImage=types.SimpleNamespace(open=lambda _: PSD()))
        source = self.root/'source.psd'; source.write_bytes(self.psd_bytes())
        with patch.dict(sys.modules, {'psd_tools': module}):
            m = packs.convert(source, self.output)
        self.assertEqual(len(m['layers']), 1)  # child never duplicated
        self.assertTrue(m['warnings'])
        self.assertEqual((self.output/'source.psd').read_bytes(), source.read_bytes())
        _, result = packs.load_pack(self.output, 'layers')
        self.assertEqual(result.getpixel((1, 1)), (255, 0, 0, 128))
        self.assertEqual(result.getpixel((0, 0))[3], 0)
        with patch.dict(sys.modules, {'psd_tools': module}), patch.object(Layer, 'clipping', True):
            with self.assertRaisesRegex(packs.PackError, 'Unsupported complex PSD'):
                packs.convert(source, self.root/'complex')
        with patch.dict(sys.modules, {'psd_tools': module}), patch.object(packs, 'MAX_LAYERS', 1):
            with self.assertRaisesRegex(packs.PackError, '64 layers'):
                packs.convert(source, self.root/'too-many')

    def test_cli_and_guarded_route(self):
        result = subprocess.run([sys.executable, 'scripts/character_pack_cli.py', '--input', str(self.source), '--output', str(self.output)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run([sys.executable, 'scripts/character_pack_cli.py', '--input', str(self.source), '--output', str(self.output)], capture_output=True)
        self.assertEqual(result.returncode, 2)
        request = fixtures.BlueprintTests.request.__get__(self)
        self.assertEqual(request('/pack-lab')[0], 200)
        for headers in ({'Host': 'evil.example'}, {'Origin': 'https://evil.example'}, {'Sec-Fetch-Site': 'cross-site'}, {'X-Forwarded-For': '127.0.0.1'}):
            self.assertEqual(request('/pack-lab', headers=headers)[0], 403)
        self.assertEqual(request('/pack-lab', client='192.0.2.1')[0], 403)
        self.assertEqual(request('/pack-lab', {})[0], 404)

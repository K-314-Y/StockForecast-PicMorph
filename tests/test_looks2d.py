import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import app
import blueprints as bp
import looks2d as looks
import training_lab
import game
from tests import test_blueprints as fixtures
URI, PNG = fixtures.URI, fixtures.PNG


class LooksTests(unittest.TestCase):
    request = fixtures.BlueprintTests.request

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        for module, filename in [(bp, 'drafts.json'), (looks, 'looks2d.json'), (training_lab, 'trained.json')]:
            p = patch.object(module, 'STORE_FILE', self.root / filename)
            p.start(); self.addCleanup(p.stop)
        self.draft = bp.create_draft(dict(action='save', name='test', trait='balanced', candidate_id='trend'))['draft']
        self.id = self.draft['id']
        game_patch = patch.object(game, 'SAVE_FILE', self.root / 'gamesave.json')
        game_patch.start(); self.addCleanup(game_patch.stop)
        self.payload = dict(draft_id=self.id, accessory_data_uri=URI, position_x_pct=-20, position_y_pct=30, scale_pct=60, visible=False)

    def test_roundtrip_independent_and_graphics(self):
        before = bp.STORE_FILE.read_bytes()
        state = app.snapshot()
        trained = training_lab.train_preview({'draft_id': self.id})
        gamefile = game.SAVE_FILE; gamefile.write_bytes(b'unchanged sentinel')
        training_lab.train_save({'draft_id': self.id})
        trained_bytes = training_lab.STORE_FILE.read_bytes()
        self.assertEqual(looks.read_look(self.id)['look']['layers'], [])
        result = looks.save_look(self.payload)
        layer = result['look']['layers'][0]
        self.assertEqual((layer['z'], layer['position_x_pct'], layer['scale_pct'], layer['visible']), (1,-20,60,False))
        self.assertEqual(looks.read_look(self.id), result)
        self.assertEqual(looks.read_accessory(self.id), ('image/png', PNG))
        looks.save_look(dict(draft_id=self.id, position_x_pct=10))
        self.assertEqual(looks.read_accessory(self.id)[1], PNG)
        self.assertEqual(bp.STORE_FILE.read_bytes(), before)
        self.assertEqual(app.snapshot(), state)
        self.assertEqual(training_lab.train_preview({'draft_id': self.id}), trained)
        self.assertEqual(gamefile.read_bytes(), b'unchanged sentinel')
        self.assertEqual(training_lab.STORE_FILE.read_bytes(), trained_bytes)
        self.assertEqual(looks.STORE_FILE.stat().st_mode & 0o777, 0o600)

    def test_invalid_inputs(self):
        for change in [dict(draft_id=None), dict(draft_id='../bad'), dict(draft_id='bp_'+'f'*32), dict(position_x_pct=True), dict(position_y_pct=float('nan')), dict(scale_pct=0), dict(visible=1), dict(weights={}), dict(accessory_data_uri='data:image/svg+xml;base64,PHN2Zz4='), dict(accessory_data_uri='data:image/png;base64,SGVsbG8='), dict(accessory_data_uri='data:image/png;base64,'+base64.b64encode(b'x'*(1048577)).decode())]:
            with self.subTest(change=list(change)), self.assertRaises(bp.BlueprintError):
                looks.save_look(self.payload | change)
            self.assertFalse(looks.STORE_FILE.exists())

    def test_corruption_and_atomic_failure(self):
        looks.save_look(self.payload)
        original = looks.STORE_FILE.read_bytes()
        with patch.object(looks.os, 'replace', side_effect=OSError('failed')):
            with self.assertRaises(bp.BlueprintError):
                jpeg = b'\xff\xd8\xff' + b'x' * 30 + b'\xff\xd9'
                looks.save_look(dict(self.payload, accessory_data_uri='data:image/jpeg;base64,' + base64.b64encode(jpeg).decode()))
        self.assertEqual(len(list((self.root/'looks2d_assets').iterdir())), 1)
        self.assertEqual(looks.read_accessory(self.id)[1], PNG)
        self.assertEqual(looks.STORE_FILE.read_bytes(), original)
        for bad in [b'{', b'[]', b'{"schema":2,"looks":{}}', original.replace(b'"scale_pct": 60', b'"scale_pct": -1')]:
            looks.STORE_FILE.write_bytes(bad)
            with self.assertRaises(bp.BlueprintError): looks.save_look(self.payload)
            self.assertEqual(looks.STORE_FILE.read_bytes(), bad)
        looks.STORE_FILE.write_bytes(original)
        asset = next((self.root/'looks2d_assets').iterdir()); asset.write_bytes(b'bad')
        with self.assertRaises(bp.BlueprintError): looks.read_look(self.id)
        with self.assertRaises(bp.BlueprintError): looks.save_look(self.payload)
        self.assertEqual(looks.STORE_FILE.read_bytes(), original)

    def test_limits_and_symlinks(self):
        with patch.object(looks, 'MAX_LOOKS', 0):
            with self.assertRaises(bp.BlueprintError): looks.save_look(self.payload)
        with patch.object(looks, 'MAX_TOTAL_BYTES', 10):
            with self.assertRaises(bp.BlueprintError): looks.save_look(self.payload)
        assets = self.root/'looks2d_assets'; assets.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(bp.BlueprintError): looks.save_look(self.payload)
        self.assertFalse(looks.STORE_FILE.exists())

    def test_http_guards_errors_and_images(self):
        url = '/api/looks2d?draft_id='+self.id
        image = '/api/looks2d/'+self.id+'/accessory'
        self.assertEqual(self.request(url)[0], 200)
        self.assertEqual(self.request(image)[0], 404)
        self.assertEqual(self.request('/api/looks2d/save', self.payload)[0], 200)
        self.assertEqual(self.request(image)[1], PNG)
        for path, payload in [(url, None), (image, None), ('/api/looks2d/save', self.payload)]:
            for headers in [{'Host':'evil.example'}, {'Origin':'https://evil.example'}, {'Sec-Fetch-Site':'cross-site'}, {'X-Forwarded-For':'127.0.0.1'}]:
                self.assertEqual(self.request(path, payload, headers)[0],403)
            self.assertEqual(self.request(path,payload,client='192.0.2.1')[0],403)
        for path in ['/api/looks2d', url+'&draft_id='+self.id, '/api/looks2d/../secret/accessory']:
            self.assertEqual(self.request(path)[0],400)
        self.assertEqual(self.request('/api/looks2d/unknown')[0],404)
        for raw in [b'{',b'[]',b'\xff',b'['*1500]:
            self.assertEqual(self.request('/api/looks2d/save',raw=raw)[0],400)
        for headers, code in [({'Content-Length':str(looks.MAX_REQUEST_BYTES+1)},413), ({'Transfer-Encoding':'chunked'},400), ({'Content-Type':'text/plain'},415)]:
            self.assertEqual(self.request('/api/looks2d/save',self.payload,headers)[0],code)

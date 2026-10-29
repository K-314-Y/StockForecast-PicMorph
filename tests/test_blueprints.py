import base64
import io
import json
from email.message import Message
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import app
import blueprints as bp
from engine import Model
from indicators import REGISTRY

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8WQAAAAASUVORK5CYII=')
URI = 'data:image/png;base64,' + base64.b64encode(PNG).decode()


class BlueprintTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Path(self.temp.name) / 'private' / 'drafts.json'
        patcher = patch.object(bp, 'STORE_FILE', self.store)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.payload = dict(name='星読み', concept='旅人', style='アニメ調', trait='balanced')

    def test_three_valid_deterministic_candidates_without_vision(self):
        for trait in bp.TRAITS:
            payload = dict(self.payload, trait=trait, action='preview')
            result = bp.create_draft(payload)
            self.assertFalse(result['generator']['vision_used'])
            self.assertEqual(result['candidates'], bp.create_draft(dict(payload, image_data_uri=URI))['candidates'])
            self.assertEqual(len(result['candidates']), 3)
            weights = []
            for candidate in result['candidates']:
                p = candidate['blueprint']['engine_parameters']
                self.assertEqual(sum(p['plugin_weights'].values()), 100)
                self.assertEqual(set(p['plugin_weights']), {s.id for s in REGISTRY})
                Model(p['fast_window'], p['slow_window'], p['risk_fraction'],
                      tuple(p['plugin_weights'][s.id] for s in REGISTRY),
                      tuple(p['plugin_strengths'][s.id] for s in REGISTRY))
                weights.append(tuple(p['plugin_weights'].values()))
            self.assertEqual(len(set(weights)), 3)
        self.assertFalse(self.store.parent.exists())

    def test_save_image_immutable_private_and_independent(self):
        state = app.snapshot()
        saved = bp.create_draft(dict(self.payload, action='save', candidate_id='trend', image_data_uri=URI))['draft']
        original = self.store.read_bytes()
        self.assertEqual(bp.read_image(saved['id']), ('image/png', PNG))
        self.assertEqual(self.store.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.store.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(saved['status'], 'draft')
        self.assertFalse(saved['competition_eligible'])
        self.assertIsNone(saved['training_job'])
        self.assertIsNone(saved['deployed_model_version'])
        bp.create_draft(dict(self.payload, action='save', candidate_id='balanced'))
        self.assertEqual(json.loads(original)['drafts'][0], bp.read_drafts(saved['id'])['draft'])
        self.assertEqual(state, app.snapshot())

    def test_invalid_inputs_do_not_write(self):
        for extra in [dict(candidate_id='../trend'), dict(candidate_id=[]),
                      dict(image_data_uri='data:image/png;base64,SGVsbG8='),
                      dict(image_data_uri='data:image/svg+xml;base64,PHN2Zz4='),
                      dict(image_data_uri='../../secret'),
                      dict(image_data_uri='data:image/png;base64,' + base64.b64encode(b'x' * (bp.MAX_IMAGE_BYTES+1)).decode()),
                      dict(trait='unknown'), dict(blueprint={})]:
            with self.subTest(extra=list(extra)):
                with self.assertRaises(bp.BlueprintError):
                    bp.create_draft(dict(self.payload, action='save', candidate_id='trend') | extra)
                self.assertFalse(self.store.parent.exists())
        with self.assertRaises(bp.BlueprintError):
            bp.read_image('../secret')

    def test_atomic_failure_preserves_existing(self):
        bp.create_draft(dict(self.payload, action='save', candidate_id='trend'))
        previous = self.store.read_bytes()
        with patch.object(bp.os, 'replace', side_effect=OSError('test')):
            with self.assertRaises(bp.BlueprintError):
                bp.create_draft(dict(self.payload, action='save', candidate_id='trend', image_data_uri=URI))
        self.assertEqual(self.store.read_bytes(), previous)
        self.assertEqual(list((self.store.parent / 'created_visual_assets').iterdir()), [])

    def test_rejected_save_preserves_catalog_and_symlink_guard(self):
        bp.create_draft(dict(self.payload, action='save', candidate_id='trend'))
        before = self.store.read_bytes()
        for extra in [dict(candidate_id='forged'), dict(image_data_uri='bad')]:
            with self.assertRaises(bp.BlueprintError):
                bp.create_draft(dict(self.payload, action='save', candidate_id='trend') | extra)
            self.assertEqual(self.store.read_bytes(), before)
        assets = self.store.parent / 'created_visual_assets'
        assets.symlink_to(self.temp.name, target_is_directory=True)
        with self.assertRaises(bp.BlueprintError):
            bp.create_draft(dict(self.payload, action='save', candidate_id='trend', image_data_uri=URI))
        self.assertEqual(self.store.read_bytes(), before)

    def test_image_magic_and_mime_validation(self):
        jpeg = b'\xff\xd8\xff' + b'x' * 30 + b'\xff\xd9'
        webp = b'RIFF' + (22).to_bytes(4, 'little') + b'WEBPVP8 ' + b'x' * 14
        for mime, data in [('image/png', PNG), ('image/jpeg', jpeg), ('image/webp', webp)]:
            uri = 'data:' + mime + ';base64,' + base64.b64encode(data).decode()
            self.assertEqual(bp.validate_image(uri), (mime, data))
        for mime in ['image/jpeg', 'image/webp']:
            with self.assertRaises(bp.BlueprintError):
                bp.validate_image('data:' + mime + ';base64,' + base64.b64encode(PNG).decode())

    def request(self, path, payload=None, headers=None, client='127.0.0.1', raw=None):
        handler = object.__new__(app.Handler)
        handler.path = path
        handler.server = SimpleNamespace(server_port=8765)
        handler.client_address = (client, 1234)
        handler.headers = Message()
        body = json.dumps(payload).encode() if raw is None else raw
        values = {'Host': 'localhost:8765', 'Content-Type': 'application/json', 'Content-Length': str(len(body))}
        values.update(headers or {})
        for key, value in values.items():
            handler.headers[key] = value
        handler.rfile = io.BytesIO(body)
        result = []
        handler._send = lambda code, data, mime: result.append((code, data, mime))
        if payload is not None or raw is not None:
            handler.do_POST()
        else:
            handler.do_GET()
        return result[0]

    def test_routes_and_local_guard_without_sockets(self):
        self.assertEqual(self.request('/create')[0], 200)
        self.assertEqual(self.request('/api/blueprints')[0], 200)
        self.assertEqual(self.request('/api/blueprints/preview', self.payload)[0], 200)
        code, body, _ = self.request('/api/blueprints/create', dict(self.payload, candidate_id='trend', image_data_uri=URI))
        self.assertEqual(code, 201)
        url = json.loads(body)['draft']['visual_asset']['url']
        self.assertEqual(self.request(url)[1], PNG)
        for path, payload in [('/create', None), ('/api/blueprints', None), (url, None), ('/api/blueprints/preview', self.payload), ('/api/blueprints/create', self.payload)]:
            for headers in [{'Host': 'public.example'}, {'Origin': 'https://public.example'}, {'X-Forwarded-For': '127.0.0.1'}, {'Sec-Fetch-Site': 'cross-site'}]:
                self.assertEqual(self.request(path, payload, headers)[0], 403)
            self.assertEqual(self.request(path, payload, client='192.0.2.1')[0], 403)
        self.assertEqual(self.request('/api/blueprints/../../secret/image')[0], 400)

    def test_bounded_json_and_legacy_limit(self):
        for raw in [b'{', b'[]', b'\xff', b'[' * 1500]:
            self.assertEqual(self.request('/api/blueprints/preview', raw=raw)[0], 400)
        self.assertEqual(self.request('/api/blueprints/preview', self.payload, {'Content-Length': str(bp.MAX_REQUEST_BYTES+1)})[0], 413)
        self.assertEqual(self.request('/api/blueprints/preview', self.payload, {'Transfer-Encoding': 'chunked'})[0], 400)
        self.assertEqual(self.request('/api/blueprints/preview', self.payload, {'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.request('/api/visual', {}, {'Content-Length': '8193'})[0], 400)
        self.assertFalse(self.store.exists())


if __name__ == '__main__':
    unittest.main()

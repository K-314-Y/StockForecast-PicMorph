import copy
import io
import json
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import app
import blueprints as bp
import game
import training_lab as lab
from engine import Model, SYNTHETIC_PRICES, prediction, multiclass_brier


class TrainingLabTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        for module, name, filename in ((bp, 'STORE_FILE', 'drafts.json'),
                                        (lab, 'STORE_FILE', 'trained_versions.json'),
                                        (game, 'SAVE_FILE', 'versions.json')):
            patcher = patch.object(module, name, self.root / filename)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.draft = bp.create_draft(dict(action='save', candidate_id='balanced',
                                         name='test', trait='cautious'))['draft']
        self.payload = {'draft_id': self.draft['id']}
        self.model = lab.model_from_parameters(self.draft['blueprint']['engine_parameters'])

    def request(self, path, payload=None, headers=None, client='127.0.0.1', raw=None):
        handler = object.__new__(app.Handler)
        handler.path = '/api/blueprints/' + path
        handler.server = SimpleNamespace(server_port=12345)
        handler.client_address = (client, 1)
        handler.headers = Message()
        body = json.dumps(payload).encode() if raw is None else raw
        values = {'Host': 'localhost:12345', 'Content-Type': 'application/json',
                  'Content-Length': str(len(body))}
        values.update(headers or {})
        for key, value in values.items():
            handler.headers[key] = value
        handler.rfile = io.BytesIO(body)
        result = []
        handler._json = lambda code, data: result.append((code, data))
        if payload is not None or raw is not None:
            handler.do_POST()
        else:
            handler.do_GET()
        return result[0]

    def test_deterministic_real_fit_valid_model_and_independent_baselines(self):
        result = lab.train_preview(self.payload)
        self.assertEqual(result, lab.train_preview(self.payload))
        fitted = lab.model_from_parameters(result['engine_parameters'])
        self.assertEqual(sum(fitted.plugin_weights), 100)
        self.assertEqual((fitted.fast_window, fitted.slow_window, fitted.risk_fraction, fitted.plugin_strengths),
                         (self.model.fast_window, self.model.slow_window, self.model.risk_fraction, self.model.plugin_strengths))
        self.assertEqual(len(set(lab.grid())), 56)
        train = lab.samples(self.model, SYNTHETIC_PRICES, lab.TRAIN_INDICES)
        selected_score = lab.score(fitted.plugin_weights, train)
        self.assertEqual(selected_score, min(lab.score(w, train) for w in lab.grid()))
        self.assertNotEqual(fitted.plugin_weights, self.model.plugin_weights)
        for split, indices in [('train', lab.TRAIN_INDICES), ('validation', lab.VALIDATION_INDICES)]:
            rows = lab.samples(self.model, SYNTHETIC_PRICES, indices)
            for prefix, model in [('original', self.model), ('trained', fitted)]:
                independent = sum(multiclass_brier(r['actual'], prediction(model, SYNTHETIC_PRICES[:r['index']+1])) for r in rows)/len(rows)
                self.assertAlmostEqual(result['scores'][prefix+'_'+split+'_brier'], independent)
            self.assertEqual(result['dataset'][split+'_labels'], [r['actual'] for r in rows])
        self.assertEqual(result['scores']['training_count'], 12)
        self.assertEqual(result['scores']['validation_count'], 7)
        self.assertAlmostEqual(multiclass_brier('UP', dict.fromkeys(lab.KEYS, 1/3)), result['scores']['uniform_brier'])
        self.assertEqual(result['trained_until'], 32)  # last label observed, not decision index

    def test_causality_every_prefix_and_feature_before_label(self):
        for index in (*lab.TRAIN_INDICES, *lab.VALIDATION_INDICES):
            original = lab.samples(self.model, SYNTHETIC_PRICES, [index])[0]
            modified = list(SYNTHETIC_PRICES)
            modified[index+1:] = [9999] * (39-index)
            self.assertEqual(original['components'], lab.samples(self.model, modified, [index])[0]['components'])
        events = []
        from engine import prediction_components
        from challenge import actual_direction
        def components(model, prices):
            events.append(('features', len(prices)))
            return prediction_components(model, prices)
        def label(start, end):
            events.append(('label', start, end))
            return actual_direction(start, end)
        with patch.object(lab, 'prediction_components', side_effect=components), patch.object(lab, 'actual_direction', side_effect=label):
            lab.train_preview(self.payload)
        self.assertEqual([e[1] for e in events[::2]], list(range(21, 40)))
        self.assertTrue(all(e[0] == 'label' for e in events[1::2]))

    def test_validation_labels_and_future_prices_cannot_select_weights(self):
        original = lab.train_preview(self.payload)
        real_samples = lab.samples
        def swapped(model, prices, indices):
            rows = real_samples(model, prices, indices)
            if indices == lab.VALIDATION_INDICES:
                for row in rows:
                    row['actual'] = 'FLAT'
            return rows
        with patch.object(lab, 'samples', side_effect=swapped):
            changed = lab.train_preview(self.payload)
        self.assertEqual(original['engine_parameters'], changed['engine_parameters'])
        self.assertNotEqual(original['scores']['trained_validation_brier'], changed['scores']['trained_validation_brier'])
        # Index 32 is the final TRAIN target; only prices after it are held out.
        with patch.object(lab, 'SYNTHETIC_PRICES', SYNTHETIC_PRICES[:33] + (9999,) * 7):
            changed = lab.train_preview(self.payload)
        self.assertEqual(original['engine_parameters'], changed['engine_parameters'])
        self.assertEqual(original['scores']['trained_train_brier'], changed['scores']['trained_train_brier'])

    def test_tie_break_proximity_then_lexicographic(self):
        parts = {k: dict.fromkeys(lab.KEYS, 1/3) for k in lab.PLUGIN_IDS}
        rows = [dict(actual='UP', components=parts)]
        with patch.object(lab, 'score', return_value=2/3):
            expected = min(lab.grid(), key=lambda w: (sum(abs(a-b) for a,b in zip(w,self.model.plugin_weights)), w))
            self.assertEqual(lab.select_weights(self.model, rows), expected)

    def test_preview_no_writes_save_separate_immutable_and_safe_metadata(self):
        game.save_version('existing', self.model)
        before_state = copy.deepcopy(app.snapshot())
        before_versions = game.read_versions()
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        result = lab.train_preview(self.payload)
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.root.iterdir()})
        saved = lab.train_save(self.payload)['version']
        first = json.loads(lab.STORE_FILE.read_text())
        lab.train_save(self.payload)
        data = json.loads(lab.STORE_FILE.read_text())
        self.assertEqual(data['versions'][0], first['versions'][0])
        self.assertEqual(data['jobs'][0], first['jobs'][0])
        self.assertEqual(saved['source_draft_sha256'], lab.digest(self.draft))
        self.assertEqual(saved['parameters_sha256'], lab.digest(result['engine_parameters']))
        self.assertEqual(saved['dataset_sha256'], lab.digest(SYNTHETIC_PRICES))
        self.assertFalse(saved['competition_eligible'])
        self.assertNotIn('training_job', data['versions'][0])
        self.assertEqual(data['jobs'][0]['id'], data['versions'][0]['training_job_id'])
        self.assertEqual(lab.STORE_FILE.stat().st_mode & 0o777, 0o600)
        for name, contents in before.items():
            self.assertEqual((self.root/name).read_bytes(), contents)
        self.assertEqual(before_state, app.snapshot())
        self.assertEqual(before_versions, game.read_versions())
        for response in [result, saved, lab.read_trained()]:
            self.assertNotIn('visual_asset', json.dumps(response))
            self.assertNotIn('image_data_uri', json.dumps(response))
        self.assertNotIn('engine_parameters', lab.read_trained()['versions'][0])

    def test_invalid_id_payload_and_arbitrary_python(self):
        for payload in [{}, {'draft_id': '../secret'}, {'draft_id': None}, {'draft_id': []},
                        dict(self.payload, python="__import__('os').system('false')"),
                        dict(self.payload, prices=[1,2]), dict(self.payload, engine_parameters={})]:
            with self.subTest(payload=payload), self.assertRaises(bp.BlueprintError):
                lab.train_preview(payload)
        with self.assertRaises(bp.BlueprintError) as error:
            lab.train_preview({'draft_id': 'bp_'+'0'*32})
        self.assertEqual(error.exception.status, 404)
        for field, value in [('fast_window', True), ('slow_window', 21), ('risk_fraction', float('nan')),
                             ('plugin_weights', {'trend': 100}), ('plugin_strengths', '__import__("os")')]:
            bad = copy.deepcopy(self.draft)
            bad['blueprint']['engine_parameters'][field] = value
            with patch.object(bp, 'read_drafts', return_value={'draft': bad}), self.assertRaises(bp.BlueprintError):
                lab.train_preview(self.payload)
        self.assertFalse(lab.STORE_FILE.exists())

    def test_atomic_failure_limit_corruption_and_symlink(self):
        lab.train_save(self.payload)
        before = lab.STORE_FILE.read_bytes()
        with patch.object(lab.os, 'replace', side_effect=OSError('test')), self.assertRaises(bp.BlueprintError):
            lab.train_save(self.payload)
        self.assertEqual(before, lab.STORE_FILE.read_bytes())
        self.assertEqual(list(self.root.glob('.trained-*')), [])
        with patch.object(lab, 'MAX_VERSIONS', 1), self.assertRaises(bp.BlueprintError) as error:
            lab.train_save(self.payload)
        self.assertEqual(error.exception.status, 413)
        lab.STORE_FILE.write_text('{broken')
        with self.assertRaises(bp.BlueprintError):
            lab.train_save(self.payload)
        self.assertEqual(lab.STORE_FILE.read_text(), '{broken')
        lab.STORE_FILE.unlink()
        lab.STORE_FILE.symlink_to(bp.STORE_FILE)
        with self.assertRaises(bp.BlueprintError):
            lab.train_save(self.payload)
        self.assertEqual(bp.read_drafts(self.draft['id'])['draft'], self.draft)

    def test_http_routes_guards_bounded_input(self):
        self.assertEqual(self.request('train-preview', self.payload)[0], 200)
        self.assertFalse(lab.STORE_FILE.exists())
        self.assertEqual(self.request('train-save', self.payload)[0], 201)
        self.assertEqual(self.request('trained')[0], 200)
        for route, payload in [('train-preview', self.payload), ('train-save', self.payload), ('trained', None)]:
            for headers in [{'Host':'evil'}, {'Origin':'https://evil'}, {'Sec-Fetch-Site':'cross-site'},
                            {'Forwarded':'localhost'}, {'X-Forwarded-For':'127.0.0.1'},
                            {'X-Forwarded-Host':'localhost'}, {'X-Forwarded-Proto':'http'}]:
                self.assertEqual(self.request(route, payload, headers)[0], 403)
            self.assertEqual(self.request(route, payload, client='192.0.2.1')[0], 403)
        for route in ['train-preview', 'train-save']:
            for raw in [b'{', b'[]', b'null', b'\xff', b'['*1500]:
                self.assertEqual(self.request(route, raw=raw)[0], 400)
            for headers, status in [({'Content-Length':'8193'},413), ({'Content-Length':'bad'},400),
                                    ({'Content-Length':'0'},413), ({'Transfer-Encoding':'chunked'},400),
                                    ({'Content-Type':'text/plain'},415)]:
                self.assertEqual(self.request(route, self.payload, headers)[0], status)
            self.assertEqual(self.request(route, dict(self.payload, python='print(1)'))[0], 400)
            padded = json.dumps(self.payload).encode().ljust(8192, b' ')
            self.assertIn(self.request(route, raw=padded)[0], (200,201))


if __name__ == '__main__':
    unittest.main()

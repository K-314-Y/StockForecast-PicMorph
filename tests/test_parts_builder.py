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
import parts_builder as parts
import training_lab as training
from engine import prediction


def loadout():
    return dict(name='観測隊', concept='', window_part_id='window:balanced', risk_part_id='risk:normal',
                analysis=[dict(part_id='indicator:trend', share=3, strength=100),
                          dict(part_id='indicator:momentum', share=1, strength=110)])


class PartsTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.store = Path(tmp.name) / 'drafts.json'
        for module, path in [(bp, self.store), (training, Path(tmp.name) / 'trained.json')]:
            patcher = patch.object(module, 'STORE_FILE', path)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_catalog_versioned_and_defensive_copy(self):
        c = parts.catalog()
        self.assertEqual(len(c['parts']), 10)
        for p in c['parts']:
            self.assertTrue({'part_id', 'kind', 'version', 'config', 'name', 'explanation'} <= p.keys())
        c['parts'][0]['config']['fast_window'] = 99
        self.assertEqual(parts.catalog()['parts'][0]['config']['fast_window'], 3)

    def test_normalization_and_registry_ties(self):
        p = loadout()
        c = parts.compile_loadout(p)
        self.assertEqual(list(c['engine_parameters']['plugin_weights'].values()), [75, 25, 0, 0])
        p['analysis'].append(dict(part_id='indicator:volatility', share=1, strength=100))
        p['analysis'][0]['share'] = 1
        p['analysis'].reverse()
        c = parts.compile_loadout(p)
        self.assertEqual(list(c['engine_parameters']['plugin_weights'].values()), [34, 33, 33, 0])
        self.assertEqual(c['engine_parameters']['plugin_strengths']['reversion'], 100)
        self.assertEqual([r['part_id'] for r in c['parts'][2:]], ['indicator:trend', 'indicator:momentum', 'indicator:volatility'])

    def test_strict_invalid_inputs(self):
        bad = [None, [], {}, dict(loadout(), script='print(1)'), dict(loadout(), name='x'*61),
               dict(loadout(), concept='x'*301), dict(loadout(), name=True), dict(loadout(), name='\n'),
               dict(loadout(), window_part_id=[]), dict(loadout(), risk_part_id='../secret'),
               dict(loadout(), analysis=[]), dict(loadout(), analysis=loadout()['analysis']*2)]
        for field in ['share', 'strength']:
            for value in [True, False, 1.0, float('nan'), '100', None, 0, 151]:
                p = loadout(); p['analysis'][0][field] = value; bad.append(p)
        for field, value in [('part_id','indicator:unknown'), ('script','evil'), ('part_id',{})]:
            p = loadout(); p['analysis'][0][field] = value; bad.append(p)
        for p in bad:
            with self.subTest(payload=p), self.assertRaises(bp.BlueprintError):
                parts.compile_loadout(p)
        self.assertFalse(self.store.exists())

    def test_preview_read_only_and_no_future_observations(self):
        before = copy.deepcopy(app.STATE)
        with patch.object(parts, 'prediction', wraps=prediction) as predict:
            result = parts.preview(loadout())
        self.assertEqual(predict.call_count, 3)
        for call, fixture, (_, observations) in zip(predict.call_args_list, result['fixtures'], parts.FIXTURES):
            self.assertEqual(call.args[1], observations)
            self.assertEqual(len(call.args[1]), fixture['target_index'])
            self.assertAlmostEqual(sum(fixture['probabilities'].values()), 1)
        self.assertFalse(self.store.exists())
        self.assertEqual(before, app.STATE)

    def test_cosmetic_and_text_independence(self):
        a = parts.preview(loadout())
        b = parts.preview(dict(loadout(), name='別の見た目', concept='赤い翼'))
        self.assertEqual(a['fixtures'], b['fixtures'])
        for field in ['visual_asset', 'image_data_uri', 'style', 'looks2d']:
            with self.assertRaises(bp.BlueprintError):
                parts.preview(dict(loadout(), **{field: 'anything'}))

    def test_manual_persistence_and_old_flow(self):
        old = bp.create_draft(dict(action='save', name='旧', trait='balanced', candidate_id='trend'))['draft']
        before = copy.deepcopy(app.STATE)
        draft = parts.create_draft(loadout())['draft']
        self.assertEqual(bp.read_drafts(old['id'])['draft'], old)
        self.assertEqual(bp.read_drafts(draft['id'])['draft'], draft)
        self.assertEqual(set(draft) - {'parts_assembly'}, set(old))
        self.assertEqual(set(draft['blueprint']['engine_parameters']), set(old['blueprint']['engine_parameters']))
        self.assertIsNone(draft['visual_asset'])
        self.assertFalse(draft['competition_eligible'])
        self.assertEqual(draft['generator']['kind'], 'manual_parts_v1')
        training.model_from_parameters(draft['blueprint']['engine_parameters'])
        self.assertEqual(before, app.STATE)
        self.assertEqual(len(bp.create_draft(dict(action='preview', name='旧', trait='balanced'))['candidates']), 3)

    def test_training_keeps_off_parts_and_actual_counts(self):
        for count, expected in [(2, 6), (3, 21), (4, 56)]:
            p = loadout()
            for key in parts.IDS[2:count]:
                p['analysis'].append(dict(part_id='indicator:'+key, share=1, strength=100))
            draft = parts.create_draft(p)['draft']
            original = self.store.read_bytes()
            result = training.train_preview(dict(draft_id=draft['id']))
            self.assertEqual(result['training_job']['candidate_count'], expected)
            for key in parts.IDS[count:]:
                self.assertEqual(result['engine_parameters']['plugin_weights'][key], 0)
            saved = training.train_save(dict(draft_id=draft['id']))
            self.assertEqual(saved['version']['status'], 'practice_only')
            self.assertEqual(self.store.read_bytes(), original)
        old = bp.create_draft(dict(action='save', name='旧', trait='balanced', candidate_id='trend'))['draft']
        self.assertEqual(training.train_preview(dict(draft_id=old['id']))['training_job']['candidate_count'], 56)

    def test_quota_and_atomic_failure_shared(self):
        parts.create_draft(loadout())
        original = self.store.read_bytes()
        with patch.object(bp, 'MAX_DRAFTS', 1), self.assertRaises(bp.BlueprintError):
            parts.create_draft(loadout())
        with patch.object(bp.os, 'replace', side_effect=OSError('private details')), self.assertRaises(bp.BlueprintError):
            parts.create_draft(loadout())
        self.assertEqual(original, self.store.read_bytes())

    def request(self, path, raw=None, extras=(), remove=(), client='127.0.0.1'):
        h = object.__new__(app.Handler)
        h.path = path
        h.server = SimpleNamespace(server_port=18918)
        h.client_address = (client, 1)
        h.headers = Message()
        defaults = [('Host', 'localhost:18918'), ('Content-Type', 'application/json'), ('Content-Length', str(len(raw or b'')))]
        for key, value in defaults:
            if key not in remove:
                h.headers[key] = value
        for key, value in extras:
            h.headers[key] = value
        h.rfile = io.BytesIO(raw or b'')
        out = []
        h._send = lambda code, data, mime: out.append((code, data))
        (h.do_GET if raw is None else h.do_POST)()
        return out[0]

    def test_http_routes_and_access(self):
        body = json.dumps(loadout()).encode()
        for path, raw in [('/assemble', None), ('/api/parts/catalog', None), ('/api/parts/preview', body), ('/api/parts/draft', body)]:
            self.assertIn(self.request(path, raw)[0], (200, 201))
            for extras, remove in [([('Host','evil')], ['Host']), ([('Origin','https://evil')], []),
                                   ([('Sec-Fetch-Site','cross-site')], []), ([('Forwarded','for=127.0.0.1')], [])]:
                self.assertEqual(self.request(path, raw, extras, remove)[0], 403)
            self.assertEqual(self.request(path, raw, client='192.0.2.1')[0], 403)
        self.assertEqual(self.request('/api/parts/unknown', body)[0], 404)
        self.assertEqual(self.request('/api/parts/preview?path=foo', body)[0], 400)

    def test_http_strict_framing_and_json(self):
        body = json.dumps(loadout()).encode()
        path = '/api/parts/preview'
        for raw in [b'{', b'[]', b'\xff', b'['*1500, b'{"name":NaN}', b'{"name":"a","name":"b"}']:
            self.assertEqual(self.request(path, raw)[0], 400)
        for extras, remove, expected in [([('Content-Length',str(len(body)))], [],400),
                ([('Transfer-Encoding','')],[],400), ([('Transfer-Encoding','chunked')],[],400),
                ([],['Content-Length'],400), ([('Content-Length','+20')],['Content-Length'],400),
                ([('Content-Length','8193')],['Content-Length'],413),
                ([('Content-Length',str(len(body)+1))],['Content-Length'],400),
                ([('Content-Type','text/plain')],['Content-Type'],415),
                ([('Content-Type','application/json')],[],415)]:
            self.assertEqual(self.request(path,body,extras,remove)[0],expected)
        self.assertFalse(self.store.exists())


if __name__ == '__main__':
    unittest.main()

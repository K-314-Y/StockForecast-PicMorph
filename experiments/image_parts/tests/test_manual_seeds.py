"""Temporary Pillow geometry only; no artwork or network."""
import copy
import hashlib
import json
import unittest
from unittest.mock import patch

from . import test_prepare_benchmark as fixtures
import prepare_benchmark as prepare
import batch_evaluate as batch


class ManualSeedsTests(unittest.TestCase):
    # Share fixture methods, but DO NOT inherit all historical tests as new tests.
    snapshot = fixtures.PrepareTests.snapshot
    reject = fixtures.PrepareTests.reject
    run_cli = fixtures.PrepareTests.run_cli
    mask = fixtures.PrepareTests.mask

    def setUp(self):
        fixtures.PrepareTests.setUp(self)
        self.seed = dict(schema_version=1, source='original.png', width=12, height=12,
                         sha256=hashlib.sha256((self.root / 'original.png').read_bytes()).hexdigest(),
                         points=dict(hair=dict(x=3, y=3), face=None, outfit=None))
        self.write_seed()
        self.args['seeds_file'] = 'seeds.json'

    def write_seed(self):
        (self.root / 'seeds.json').write_text(json.dumps(self.seed), encoding='utf-8')

    def test_manual_in_truth_shared_seed_and_provenance(self):
        before = self.snapshot()
        with patch.object(prepare, 'seed_inside', side_effect=AssertionError('oracle called')):
            prepare.prepare(**dict(self.args, adaptive=True))
        manifest = self.root / 'benchmark.json'
        cases = json.loads(manifest.read_text())['cases']
        self.assertEqual([(c['seed_x'], c['seed_y']) for c in cases], [(3, 3), (3, 3)])
        result = batch.batch_evaluate(manifest)
        self.assertEqual(result['seed_selection'], 'image_only_manual')
        self.assertEqual(result['total']['iou']['mean'], 1)
        self.assertIn('cannot prove honesty', result['seed_protocol_notice'])
        self.assertNotIn('PRIVATE', json.dumps(result))
        for name, raw in before.items():
            self.assertEqual((self.root / name).read_bytes(), raw)

    def test_manual_outside_truth_is_scored_miss(self):
        self.seed['points']['hair'] = dict(x=0, y=0)
        self.write_seed()
        with patch.object(prepare, 'seed_inside', side_effect=AssertionError):
            prepare.prepare(**self.args)
        result = batch.batch_evaluate(self.root / 'benchmark.json')
        self.assertEqual(result['total']['iou']['mean'], 0)
        self.assertTrue(result['cases'][0]['segmentation_rejected'])

    def test_hash_mismatch(self):
        self.seed['sha256'] = '0' * 64
        self.write_seed(); self.reject()

    def test_name_mismatch(self):
        self.seed['source'] = 'other.png'
        self.write_seed(); self.reject()

    def test_dimensions_mismatch(self):
        self.seed['width'] = 13
        self.write_seed(); self.reject()

    def test_out_of_range(self):
        for x in (-1, 12):
            self.seed['points']['hair']['x'] = x
            self.write_seed(); self.reject()

    def test_wrong_types_and_exact_keys(self):
        original = copy.deepcopy(self.seed)
        for key, value in [('schema_version', True), ('width', True), ('height', 12.0),
                           ('sha256', 'A' * 64), ('extra', 1), ('points', [])]:
            self.seed = dict(copy.deepcopy(original), **{key: value})
            self.write_seed(); self.reject()
        for point in ({'x': True, 'y': 3}, {'x': 3.0, 'y': 3}, {'x': 3},
                      {'x': 3, 'y': 3, 'z': 0}, '3,3'):
            self.seed = copy.deepcopy(original)
            self.seed['points']['hair'] = point
            self.write_seed(); self.reject()

    def test_duplicate_keys_and_size(self):
        path = self.root / 'seeds.json'
        path.write_text(json.dumps(self.seed).replace('"x": 3', '"x": 3, "x": 4'))
        self.reject()
        path.write_text(' ' * (16 * 1024 + 1))
        self.reject()

    def test_malicious_seed_paths(self):
        for name in ('../seeds.json', '/tmp/seeds.json', './seeds.json', 'sub/seeds.json', 'x\\seeds.json'):
            self.reject(seeds_file=name)

    def test_seed_symlink_and_hardlink(self):
        (self.root / 'link.json').symlink_to(self.root / 'seeds.json')
        self.reject(seeds_file='link.json')
        (self.root / 'hard.json').hardlink_to(self.root / 'original.png')
        self.reject(seeds_file='hard.json')

    def test_missing_point_for_truth(self):
        self.reject(face_truth='face.png')
        self.seed['points']['hair'] = None
        self.write_seed(); self.reject()

    def test_unicode_original_name(self):
        (self.root / 'original.png').rename(self.root / '元画像.png')
        self.seed['source'] = '元画像.png'
        self.write_seed()
        prepare.prepare(**dict(self.args, source='元画像.png'))
        self.assertEqual(batch.batch_evaluate(self.root / 'benchmark.json')['seed_selection'], 'image_only_manual')

    def test_cli_no_leak_on_seed_error(self):
        self.seed['sha256'] = 'PRIVATE'
        self.write_seed()
        code, stdout, _ = self.run_cli()
        self.assertEqual((code, stdout), (2, ''))
        self.assertFalse((self.root / 'benchmark.json').exists())

    def test_legacy_and_optional_provenance(self):
        prepare.prepare(**dict(self.args, seeds_file=None))
        path = self.root / 'benchmark.json'
        data = json.loads(path.read_text())
        self.assertEqual(data.pop('seed_selection'), 'truth_assisted')
        path.write_text(json.dumps(data))
        self.assertEqual(batch.batch_evaluate(path)['seed_selection'], 'truth_assisted')
        for value in ('unknown', None, [], 1):
            data['seed_selection'] = value
            path.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                batch.preflight(path)

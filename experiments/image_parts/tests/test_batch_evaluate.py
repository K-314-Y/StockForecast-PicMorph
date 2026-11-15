import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw
import batch_evaluate as batch


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        image = Image.new('RGB', (8, 8), 'white')
        ImageDraw.Draw(image).rectangle((1, 1, 2, 2), fill='red')
        image.save(self.root / 'private-source.png')
        self.mask('truth.png')
        self.mask('prediction.png')
        self.case = dict(id='private_id', part='hair', method='mask',
                         source='private-source.png', truth='truth.png', prediction='prediction.png',
                         rights=dict(basis='self_created', evidence='Private creator reference 2026-11-14',
                                     local_evaluation_allowed=True, redistribution_allowed=False,
                                     covered_files=['source', 'truth', 'prediction']))
        self.data = dict(schema_version=1, dataset_type='synthetic_original', cases=[self.case])
        self.manifest = self.root / 'manifest.json'

    def mask(self, name, empty=False):
        image = Image.new('L', (8, 8))
        if not empty:
            ImageDraw.Draw(image).rectangle((1, 1, 2, 2), fill=255)
        image.save(self.root / name)

    def write(self):
        self.manifest.write_text(json.dumps(self.data), encoding='utf-8')

    def run_batch(self):
        self.write()
        return batch.batch_evaluate(self.manifest)

    def reject(self):
        self.write()
        before = {p.name: p.read_bytes() for p in self.root.iterdir() if p.is_file()}
        with patch.object(batch, 'read_png') as read, self.assertRaises((ValueError, OSError)):
            batch.batch_evaluate(self.manifest)
        read.assert_not_called()
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.root.iterdir() if p.is_file()})

    def test_self_created_and_anonymity_no_output(self):
        self.write()
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        result = batch.batch_evaluate(self.manifest)
        self.assertEqual(result['total']['iou']['mean'], 1)
        self.assertEqual(result['cases'][0]['id'], 'case_001')
        serialized = json.dumps(result)
        for private in ('private-source', 'private_id', self.case['rights']['evidence'], str(self.root)):
            self.assertNotIn(private, serialized)
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.root.iterdir()})
        self.assertIn('not_real_art_accuracy', result['interpretation'])

    def test_permission_rejection(self):
        for key, value in [('basis', 'internet_public'), ('basis', 'unknown'),
                           ('local_evaluation_allowed', False), ('local_evaluation_allowed', 1),
                           ('redistribution_allowed', True), ('evidence', ''),
                           ('evidence', 'javascript:alert(1)'), ('evidence', 'https:///missing'),
                           ('evidence', '<script>bad</script>')]:
            with self.subTest(key=key, value=value):
                rights = copy.deepcopy(self.case['rights'])
                self.case['rights'][key] = value
                self.reject()
                self.case['rights'] = rights
        del self.case['rights']['evidence']
        self.reject()

    def test_synthetic_dataset_rejects_third_party_licensed_art(self):
        self.case["rights"]["basis"] = "licensed"
        self.case["rights"]["evidence"] = "https://example.org/artist-licensed-image"
        self.reject()
        self.data["dataset_type"] = "permissioned_art"
        self.assertEqual(self.run_batch()["dataset_type"], "permissioned_art")

    def test_permission_scope_covers_derived_masks_as_well_as_source(self):
        for covers in ([], ['source'], ['source', 'truth'],
                       ['truth', 'source', 'prediction'],
                       ['source', 'truth', 'prediction', 'output'],
                       ['source', 'truth', 'prediction', 'prediction']):
            with self.subTest(covers=covers):
                self.case['rights']['covered_files'] = covers
                self.reject()
        del self.case['rights']['covered_files']
        self.reject()

    def test_permissioned_bases_and_https_reference(self):
        self.data['dataset_type'] = 'permissioned_art'
        for basis in ('author_permission', 'licensed'):
            self.case['rights'].update(basis=basis, evidence='https://example.org/license')
            self.assertEqual(self.run_batch()['dataset_type'], 'permissioned_art')

    def test_path_escape_urls_and_missing(self):
        for path in ('../outside.png', '/tmp/outside.png', 'https://example.org/a.png',
                     'file:///tmp/a.png', 'sub/../truth.png', 'missing.png', './truth.png'):
            with self.subTest(path=path):
                self.case['source'] = path
                self.reject()

    def test_symlink_file_directory_and_manifest(self):
        (self.root / 'alias.png').symlink_to(self.root / 'truth.png')
        (self.root / 'alias').symlink_to(self.root, target_is_directory=True)
        for value in ('alias.png', 'alias/truth.png'):
            self.case['source'] = value
            self.reject()
        self.case['source'] = 'private-source.png'
        self.write()
        alias = self.root / 'linked.json'
        alias.symlink_to(self.manifest)
        with self.assertRaises(ValueError):
            batch.batch_evaluate(alias)

    def test_all_or_nothing_duplicate_ids_and_unknown_keys(self):
        second = copy.deepcopy(self.case)
        self.data['cases'].append(second)
        self.reject()
        second['id'] = 'second'
        second['rights']['basis'] = 'internet_public'
        self.reject()
        second['rights']['basis'] = 'self_created'
        second['output'] = 'out.png'
        self.reject()
        del second['output']
        second['id'] = '../../private'
        self.reject()

    def test_strict_method_parameters(self):
        for key, value in [('seed_x', 1), ('unexpected', True)]:
            self.case[key] = value
            self.reject()
            del self.case[key]
        self.case['method'] = 'seeded'
        del self.case['prediction']
        self.case.update(seed_x=1, seed_y=1, tolerance=0)
        self.case['rights']['covered_files'] = ['source', 'truth']
        self.assertEqual(self.run_batch()['total']['iou']['mean'], 1)
        for key, value in [('seed_x', True), ('seed_y', -1), ('tolerance', 256), ('tolerance', 1.5)]:
            old = self.case[key]
            self.case[key] = value
            self.reject()
            self.case[key] = old

    def test_empty_truth_excluded_and_zero_nonempty(self):
        self.mask('empty.png', empty=True)
        empty = copy.deepcopy(self.case)
        empty.update(id='empty', truth='empty.png', prediction='empty.png')
        self.data['cases'].append(empty)
        result = self.run_batch()
        self.assertEqual(result['total']['nonempty_truth_count'], 1)
        self.assertEqual(result['total']['empty_truth']['both_empty_count'], 1)
        self.data['cases'] = [empty]
        result = self.run_batch()
        self.assertIsNone(result['total']['iou']['mean'])
        self.assertEqual(result['score_status'], 'no_nonempty_truth')
        empty['prediction'] = 'prediction.png'
        self.assertEqual(self.run_batch()['total']['empty_truth']['false_positive_pixels'], 4)

    def test_groups_averages_median_min_worst(self):
        self.mask('empty.png', empty=True)
        missed = copy.deepcopy(self.case)
        missed.update(id='missed', prediction='empty.png')
        other = copy.deepcopy(self.case)
        other.update(id='other', part='face')
        self.data['cases'] += [missed, other]
        result = self.run_batch()
        hair = next(g for g in result['groups'] if g['part'] == 'hair')
        for metric in ('iou', 'f1'):
            self.assertEqual(hair[metric]['mean'], .5)
            self.assertEqual(hair[metric]['median'], .5)
            self.assertEqual(hair[metric]['min'], 0)
            self.assertEqual(hair[metric]['worst_cases'][0], 'case_002')
            self.assertAlmostEqual(result['total'][metric]['mean'], 2 / 3)

    def test_semantic_method(self):
        image = Image.new('RGB', (8, 8))
        ImageDraw.Draw(image).rectangle((1, 1, 2, 2), fill=(255, 0, 0))
        image.save(self.root / 'prediction.png')
        self.case['method'] = 'anime-seg-rgb'
        self.assertEqual(self.run_batch()['total']['iou']['mean'], 1)

    def test_limits_schema_and_duplicate_json_keys(self):
        self.data['cases'] = [self.case] * 101
        self.reject()
        self.data['cases'] = []
        self.reject()
        self.data['cases'] = [self.case]
        self.data['schema_version'] = True
        self.reject()
        self.manifest.write_bytes(b' ' * (batch.MAX_MANIFEST_BYTES + 1))
        with self.assertRaises(ValueError):
            batch.preflight(self.manifest)
        self.manifest.write_text('{"schema_version":1,"schema_version":1}')
        with self.assertRaises(ValueError):
            batch.preflight(self.manifest)

    def test_cli_subprocess_stdout_only_no_files(self):
        self.write()
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        command = [sys.executable, '-B', str(Path(batch.__file__).resolve()), '--manifest', 'manifest.json']
        proc = subprocess.run(command, cwd=self.root, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)['total']['count'], 1)
        self.assertEqual(proc.stderr, '')
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.root.iterdir()})
        self.case['rights']['evidence'] = 'javascript:private_secret'
        self.write()
        proc = subprocess.run(command, cwd=self.root, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 2)
        self.assertIn('error', json.loads(proc.stdout))
        self.assertNotIn('private_secret', proc.stdout + proc.stderr)


if __name__ == '__main__':
    unittest.main()

import contextlib
import io
import os
import stat
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw
import batch_evaluate as batch
import prepare_benchmark as prepare


class PrepareTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        image = Image.new('RGB', (12, 12), 'white')
        ImageDraw.Draw(image).rectangle((2, 2, 4, 4), fill='red')
        image.save(self.root / 'original.png')
        for name in ('hair.png', 'face.png', 'outfit.png', 'pred.png'):
            self.mask(name)
        self.args = dict(folder=str(self.root), source='original.png', hair_truth='hair.png',
                         basis='self_created', evidence='PRIVATE creator record 2026-11-14',
                         dataset_type='synthetic_original', tolerance=20,
                         confirm_local_evaluation=True, output='benchmark.json')

    def mask(self, name, empty=False, size=(12, 12)):
        image = Image.new('L', size)
        if not empty:
            ImageDraw.Draw(image).rectangle((2, 2, 4, 4), fill=255)
        image.save(self.root / name)

    def snapshot(self):
        return {p.name: p.read_bytes() for p in self.root.iterdir() if p.is_file()}

    def reject(self, **changes):
        before = self.snapshot()
        with self.assertRaises((ValueError, OSError)):
            prepare.prepare(**dict(self.args, **changes))
        self.assertEqual(before, self.snapshot())

    def run_cli(self, changes=None, omit=()):
        args = dict(self.args, **(changes or {}))
        argv = []
        for key, value in args.items():
            if key in omit or value is None or value is False:
                continue
            argv.append('--' + key.replace('_', '-'))
            if value is not True:
                argv.append(str(value))
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = prepare.main(argv)
        messages = stdout.getvalue() + stderr.getvalue()
        for private in (str(self.root), self.args['evidence'], 'original.png', 'hair.png', 'PRIVATE'):
            self.assertNotIn(private, messages)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_one_part_preflight_exact_scoring_and_no_input_mutation(self):
        before = self.snapshot()
        self.assertEqual(prepare.prepare(**self.args), (1, []))
        manifest = self.root / 'benchmark.json'
        self.assertEqual(stat.S_IMODE(manifest.stat().st_mode) & 0o077, 0)
        dataset, cases = batch.preflight(manifest)
        self.assertEqual(dataset, 'synthetic_original')
        self.assertEqual(len(cases), 1)
        case = json.loads(manifest.read_text())['cases'][0]
        self.assertEqual(case['id'], 'hair_seeded')
        self.assertEqual(case['rights']['covered_files'], ['source', 'truth'])
        result = batch.batch_evaluate(manifest)
        self.assertEqual(result['total']['iou']['mean'], 1)
        self.assertEqual(result['cases'][0]['tp'], 9)
        for name, content in before.items():
            self.assertEqual((self.root / name).read_bytes(), content)
        self.assertEqual(set(self.snapshot()) - set(before), {'benchmark.json'})

    def test_three_parts_and_independent_prediction(self):
        args = dict(self.args, face_truth='face.png', outfit_truth='outfit.png', hair_prediction='pred.png')
        self.assertEqual(prepare.prepare(**args), (4, []))
        manifest = self.root / 'benchmark.json'
        data = json.loads(manifest.read_text())
        self.assertEqual([c['id'] for c in data['cases']],
                         ['hair_seeded', 'hair_mask', 'face_seeded', 'outfit_seeded'])
        self.assertEqual(data['cases'][1]['rights']['covered_files'], ['source', 'truth', 'prediction'])
        self.assertEqual(batch.batch_evaluate(manifest)['total']['iou']['mean'], 1)

    def test_seed_bbox_hole_is_positive_and_nearest(self):
        image = Image.new('L', (12, 12))
        ImageDraw.Draw(image).rectangle((2, 2, 8, 8), outline=255)
        image.save(self.root / 'hair.png')
        prepare.prepare(**self.args)
        case = json.loads((self.root / 'benchmark.json').read_text())['cases'][0]
        self.assertEqual((case['seed_x'], case['seed_y']), (5, 2))
        self.assertEqual(image.getpixel((case['seed_x'], case['seed_y'])), 255)

    def test_empty_skipped_warning_and_all_empty_rejected(self):
        self.mask('hair.png', empty=True)
        self.reject()
        code, stdout, stderr = self.run_cli({'face_truth': 'face.png'})
        self.assertEqual(code, 0)
        self.assertEqual(stdout, 'success\n')
        self.assertIn('empty truth skipped: hair', stderr)
        self.assertEqual(len(batch.preflight(self.root / 'benchmark.json')[1]), 1)

    def test_permission_and_malformed_evidence(self):
        for changes in ({'confirm_local_evaluation': False}, {'basis': 'public'},
                        {'basis': 'licensed'}, {'dataset_type': 'unknown'},
                        *({'evidence': e} for e in ('', 'short', '<private>bad</private>',
                            'javascript:private_secret', 'https:///private', 'private\nreference'))):
            with self.subTest(changes=changes):
                self.reject(**changes)
        self.assertEqual(prepare.prepare(**dict(self.args, basis='licensed',
                         dataset_type='permissioned_art'))[0], 1)

    def test_invalid_paths_symlinks_and_duplicates(self):
        (self.root / 'link.png').symlink_to(self.root / 'hair.png')
        for name in ('link.png', '/tmp/private.png', '../hair.png', './hair.png',
                     'sub/hair.png', 'sub\\hair.png', 'https://private/a.png', 'missing.png', ''):
            with self.subTest(name=name):
                self.reject(hair_truth=name)
        self.reject(face_truth='hair.png')
        self.reject(hair_prediction='hair.png')
        self.reject(source='hair.png')
        (self.root / 'hard.png').hardlink_to(self.root / 'hair.png')
        self.reject(hair_prediction='hard.png')
        (self.root / 'alias').symlink_to(self.root, target_is_directory=True)
        self.reject(folder=str(self.root / 'alias'))

    def test_refuses_folder_inside_git_repository(self):
        git_marker = self.root / '.git'
        git_marker.mkdir()
        self.reject()
        git_marker.rmdir()
        nested = self.root / 'metadata'
        nested.mkdir()
        (nested / '.git').write_text('gitdir: /tmp/unused', encoding='utf-8')
        self.reject(folder=str(nested))

    def test_prediction_missing_truth_missing_and_dimensions(self):
        self.reject(face_prediction='pred.png')
        self.reject(hair_prediction='missing.png')
        self.reject(hair_truth=None)
        self.mask('small.png', size=(6, 6))
        self.reject(hair_truth='small.png')
        self.reject(hair_prediction='small.png')
        Image.new('RGB', (12, 12)).save(self.root / 'invalid.png')
        self.reject(hair_prediction='invalid.png')
        (self.root / 'bad.png').write_bytes(b'not PNG')
        self.reject(hair_truth='bad.png')

    def test_output_exists_invalid_omitted_and_local_state(self):
        for output in ('', '../out.json', '/tmp/out.json', 'original.png', 'out.txt', 'sub/out.json'):
            self.reject(output=output)
        self.assertEqual(self.run_cli(omit=('output',))[0], 2)
        self.assertEqual(self.run_cli({'output': ''})[0], 2)
        (self.root / 'benchmark.json').symlink_to(self.root / 'absent.json')
        self.reject()
        (self.root / 'benchmark.json').unlink()
        (self.root / 'benchmark.json').write_text('KEEP')
        self.reject()
        self.assertEqual((self.root / 'benchmark.json').read_text(), 'KEEP')
        local = self.root / 'local_state'
        local.mkdir()
        self.reject(folder=str(local))

    def test_cli_private_errors_and_confirmation(self):
        for changes in ({'confirm_local_evaluation': False}, {'evidence': 'javascript:PRIVATE'},
                        {'hair_truth': '/private/SECRET.png'}, {'tolerance': 'PRIVATE'}):
            code, stdout, stderr = self.run_cli(changes)
            self.assertEqual(code, 2)
            self.assertEqual(stdout, '')
            self.assertNotIn('SECRET', stderr)
            self.assertFalse((self.root / 'benchmark.json').exists())
        self.assertEqual(self.run_cli()[0], 0)

    def test_exclusive_creation_and_permission_denied(self):
        original_open = os.open
        def denied(path, flags, mode=0o777, *args, **kwargs):
            if Path(path).name == 'benchmark.json':
                self.assertTrue(flags & os.O_EXCL)
                self.assertEqual(mode, 0o600)
                raise PermissionError('PRIVATE')
            return original_open(path, flags, mode, *args, **kwargs)
        with patch.object(prepare.os, 'open', denied):
            self.assertEqual(self.run_cli()[0], 2)
        self.assertFalse((self.root / 'benchmark.json').exists())


if __name__ == '__main__':
    unittest.main()

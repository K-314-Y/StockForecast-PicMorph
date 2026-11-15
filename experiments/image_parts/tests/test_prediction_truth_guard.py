"""Prevent raw predicted browser PNGs from being confused with gold masks."""
import json
from pathlib import Path
import tempfile
import unittest
from PIL import Image, ImageDraw

import prepare_benchmark as prepare
import batch_evaluate as batch


class PredictionTruthGuardTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='creature_original_prediction_')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        image = Image.new('RGB',(24,24),'white')
        ImageDraw.Draw(image).rectangle((4,4,9,9),fill='red')
        image.save(self.root/'source.png')
        mask = Image.new('L',(24,24),0)
        ImageDraw.Draw(mask).rectangle((4,4,9,9),fill=255)
        mask.save(self.root/'creature_prediction_hair_seeded_x4_y4_t20_test.png')
        mask.save(self.root/'gold_by_human.png')

    def rights(self):
        return {
            'basis':'self_created',
            'evidence':'Original geometric drawing and masks made by creator',
            'local_evaluation_allowed':True,'redistribution_allowed':False,
            'covered_files':['source','truth'],
        }

    def test_preparer_rejects_raw_browser_prediction_as_gold(self):
        with self.assertRaises(ValueError):
            prepare.prepare(folder=str(self.root),source='source.png',
                hair_truth='creature_prediction_hair_seeded_x4_y4_t20_test.png',
                basis='self_created', evidence=self.rights()['evidence'],
                dataset_type='synthetic_original',tolerance=20,
                confirm_local_evaluation=True,output='benchmark.json')
        self.assertFalse((self.root/'benchmark.json').exists())

    def test_direct_manifest_rejects_browser_prediction_as_gold(self):
        manifest=self.root/'manifest.json'
        case=dict(id='hair_seeded',part='hair',method='seeded',
                  source='source.png',truth='creature_prediction_hair_seeded_x4_y4_t20_test.png',
                  rights=self.rights(),seed_x=5,seed_y=5,tolerance=20)
        manifest.write_text(json.dumps(dict(schema_version=1,
            dataset_type='synthetic_original',cases=[case])))
        with self.assertRaises(ValueError):
            batch.preflight(manifest)
        case['truth']='gold_by_human.png'
        manifest.write_text(json.dumps(dict(schema_version=1,
            dataset_type='synthetic_original',cases=[case])))
        self.assertEqual(len(batch.preflight(manifest)[1]),1)

if __name__=='__main__':
    unittest.main()

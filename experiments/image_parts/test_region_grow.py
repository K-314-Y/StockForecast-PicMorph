"""Standalone deterministic fixtures: run python3 -m unittest discover -s experiments/image_parts -p 'test_*.py'."""
import tempfile
import unittest
from pathlib import Path

from PIL import Image
from region_grow import extract_region, generate


class SeededRegionTests(unittest.TestCase):
    def setUp(self):
        self.image = Image.new("RGBA",(64,48),(243,243,243,255))
        for y in range(6,27):
            for x in range(8,29):
                self.image.putpixel((x,y),(205,67,100,255))
        for y in range(6,27):
            for x in range(35,56):
                self.image.putpixel((x,y),(205,67,100,255))

    def test_region_is_connected_and_keeps_full_canvas(self):
        out,metrics=extract_region(self.image,10,11,tolerance=4)
        self.assertEqual(out.size,self.image.size)
        self.assertEqual(metrics.selected_pixels,21*21)
        self.assertEqual(out.getpixel((10,11)),(205,67,100,255))
        self.assertEqual(out.getpixel((38,11)),(0,0,0,0))  # Same colour, but disconnected
        self.assertEqual(out.getpixel((1,1)),(0,0,0,0))
        self.assertFalse(metrics.touched_boundary)

    def test_colour_boundary_preserved(self):
        out,metrics=extract_region(self.image,20,20,tolerance=10)
        self.assertEqual(metrics.coverage,round(441/(64*48),6))
        self.assertEqual(out.getpixel((30,20))[3],0)

    def test_semistransparent_pixels_keep_original_alpha(self):
        self.image.putpixel((10,11),(205,67,100,128))
        out, metrics = extract_region(self.image,10,11,tolerance=5)
        self.assertEqual(out.getpixel((10,11))[3],128)
        self.assertGreater(metrics.selected_pixels,0)

    def test_transparent_and_invalid_seed_rejected(self):
        self.image.putpixel((10,11),(205,67,100,0))
        with self.assertRaisesRegex(ValueError,'transparent'):
            extract_region(self.image,10,11)
        with self.assertRaisesRegex(ValueError,'within'):
            extract_region(self.image,-1,10)
        with self.assertRaisesRegex(ValueError,'tolerance'):
            extract_region(self.image,11,10,tolerance=999)

    def test_overwide_background_region_is_not_silent_success(self):
        with self.assertRaisesRegex(ValueError,'too much'):
            extract_region(self.image,0,0,tolerance=0,max_coverage=0.25)

    def test_original_never_modified_and_cli_side_effect_is_only_explicit_output(self):
        before=self.image.tobytes()
        with tempfile.TemporaryDirectory() as folder:
            inp=Path(folder)/"input.png";out=Path(folder)/"output.png"
            self.image.save(inp)
            result=generate(inp,out,x=10,y=10,tolerance=5)
            self.assertFalse(result['semantic_detection'])
            self.assertTrue(out.is_file())
            with Image.open(out) as output_image:
                self.assertEqual(output_image.size,self.image.size)
            with Image.open(inp) as input_image:
                self.assertEqual(input_image.tobytes(),before)
            with self.assertRaisesRegex(ValueError,'different files'):
                generate(inp,inp,x=10,y=10,tolerance=5)


if __name__ == "__main__":
    unittest.main()

"""Python/JavaScript exact-mask parity with generated geometry; no user artwork."""
import base64
import json
from pathlib import Path
import shutil
import subprocess
import unittest

from PIL import Image, ImageDraw
from region_grow import extract_region
from adaptive_region import extract_region_adaptive

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("node"), "Node.js required for browser algorithm parity")
class PreviewExtractParityTests(unittest.TestCase):
    NODE = """
const fs=require('fs');
const {grow}=require(process.argv[1]);
(async()=>{
 const v=JSON.parse(fs.readFileSync(0,'utf8'));
 const rgba=Uint8Array.from(Buffer.from(v.rgba,'base64'));
 try{
  const r=await grow(rgba,v.w,v.h,v.x,v.y,v.options,()=>true,async()=>{});
  process.stdout.write(JSON.stringify({ok:true,mask:Buffer.from(r.selected).toString('base64'),count:r.count}));
 }catch(e){
  process.stdout.write(JSON.stringify({ok:false,error:String(e)}));
 }
})().catch(e=>{console.error(e);process.exit(1)});
"""
    def call_js(self, image, seed, method):
        data = {
            "w": image.width, "h": image.height, "x": seed[0], "y": seed[1],
            "rgba": base64.b64encode(image.convert("RGBA").tobytes()).decode("ascii"),
            "options": {"method": method, "tolerance": 20, "step": 18, "drift": 90},
        }
        proc = subprocess.run(
            ["node", "-e", self.NODE, str(ROOT / "preview_extract.js")],
            input=json.dumps(data), text=True, capture_output=True, timeout=15,
            check=True)
        return json.loads(proc.stdout)

    def geometry(self, variant):
        image = Image.new("RGBA", (64, 48), (245, 245, 245, 255))
        seed = (12, 15)
        if variant == "gradient":
            for x in range(10, 34):
                for y in range(8, 28):
                    image.putpixel((x, y), (60 + 3*(x-10), 80 + 2*(x-10), 140, 255))
        elif variant == "edge":
            ImageDraw.Draw(image).rectangle((10, 8, 33, 27), fill=(80, 80, 80, 255))
        elif variant == "bridge":
            ImageDraw.Draw(image).rectangle((10, 12, 20, 25), fill=(80, 80, 80, 255))
            seed = (13, 18)
            for x in range(21, 34):
                for y in range(17, 21):
                    value = 80 + 3*(x-20)
                    image.putpixel((x, y), (value, value, value, 255))
        elif variant == "transparent":
            image = Image.new("RGBA", (64, 48), (0, 0, 0, 0))
            ImageDraw.Draw(image).rectangle((10, 8, 33, 27), fill=(90, 80, 70, 128))
        elif variant == "disconnected":
            ImageDraw.Draw(image).rectangle((10, 8, 33, 27), fill=(60, 60, 60, 255))
            ImageDraw.Draw(image).rectangle((20, 8, 20, 27), fill=(245, 245, 245, 255))
        elif variant == "oversized_background":
            seed = (2, 2)
        else:
            raise ValueError("unknown fixture")
        return image, seed

    def test_python_js_fixed_and_adaptive_pixel_masks(self):
        for variant in ("gradient", "edge", "bridge", "transparent", "disconnected",
                        "oversized_background"):
            image, seed = self.geometry(variant)
            for method in ("seeded", "adaptive-seeded"):
                with self.subTest(variant=variant, method=method):
                    actual = self.call_js(image, seed, method)
                    try:
                        if method == "seeded":
                            result, metrics = extract_region(image, *seed, tolerance=20)
                        else:
                            result, metrics = extract_region_adaptive(
                                image, *seed, step_tolerance=18, drift_tolerance=90)
                    except ValueError:
                        self.assertFalse(actual["ok"])
                    else:
                        self.assertTrue(actual["ok"], actual)
                        expected = bytes(1 if p[3] >= 16 else 0
                                         for p in result.convert("RGBA").get_flattened_data())
                        self.assertEqual(base64.b64decode(actual["mask"]), expected)
                        self.assertEqual(actual["count"], metrics.selected_pixels)

    def test_mask_is_strictly_binary(self):
        image, seed = self.geometry("transparent")
        answer = self.call_js(image, seed, "adaptive-seeded")
        self.assertTrue(answer["ok"])
        self.assertEqual(set(base64.b64decode(answer["mask"])), {0, 1})


if __name__ == "__main__":
    unittest.main()

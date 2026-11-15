"""Offline refined prediction checks; synthetic bytes only."""
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
JS = ROOT / 'refine_prediction.js'


class RefinePredictionTests(unittest.TestCase):
    def run_js(self, body):
        code = 'const assert=require("node:assert/strict");const u=require(' + json.dumps(str(JS)) + ');' + body
        subprocess.run(['node', '-e', code], check=True, capture_output=True, text=True)

    def test_binary_import(self):
        self.run_js('assert.deepEqual([...u.binaryMask(new Uint8Array([255,255,255,255,12,34,56,0]))],[1,0]);')

    def test_reject_cutout(self):
        self.run_js('for(const p of [[1,255,255,255],[255,255,255,127]])assert.throws(()=>u.binaryMask(new Uint8Array(p)));')

    def test_binary_errors(self):
        self.run_js('for(const m of [[],new Uint8Array(),new Uint8Array([2]),new Uint8Array(2000001)])assert.throws(()=>u.binary(m));assert.throws(()=>u.binaryMask([255,255,255,255]));')

    def test_brush_disk(self):
        self.run_js('const m=new Uint8Array(49);u.brushDisk(m,7,7,3,3,2,1);assert.equal(m.reduce((a,b)=>a+b),13);assert.equal(m[1*7+1],0);u.brushDisk(m,7,7,3,3,2,0);assert.equal(m.reduce((a,b)=>a+b),0);')

    def test_brush_edges_and_errors(self):
        self.run_js('const m=new Uint8Array(9);u.brushDisk(m,3,3,0,0,2,1);assert.equal(m.reduce((a,b)=>a+b),6);u.brushDisk(m,3,3,-100,100,2,1);assert.equal(m.length,9);for(const r of [1,41,NaN])assert.throws(()=>u.brushDisk(m,3,3,0,0,r,1));assert.throws(()=>u.brushDisk(m,2,2,0,0,2,1));')

    def test_diff(self):
        self.run_js('const a=new Uint8Array([1,0,1,0]),b=new Uint8Array([0,1,1,0]);assert.deepEqual(u.countDiff(a,b),{selected:2,added:1,removed:1});assert.deepEqual([...a],[1,0,1,0]);assert.throws(()=>u.countDiff(a,new Uint8Array([0])));')

    def test_mask_export(self):
        self.run_js('const m=new Uint8Array([1,0]);assert.deepEqual([...u.maskBytes(m)],[255,255,255,255,0,0,0,0]);assert.deepEqual([...m],[1,0]);assert.deepEqual([...u.binaryMask(u.maskBytes(m))],[1,0]);')

    def test_cutout_alpha_and_no_mutation(self):
        self.run_js('const s=new Uint8ClampedArray([12,34,56,128,80,90,100,255,9,8,7,0]),m=new Uint8Array([1,0,1]),before=s.slice();assert.deepEqual([...u.cutoutBytes(s,m)],[12,34,56,128,0,0,0,0,9,8,7,0]);assert.deepEqual(s,before);assert.deepEqual([...m],[1,0,1]);')

    def test_export_errors(self):
        self.run_js('assert.throws(()=>u.cutoutBytes(new Uint8Array(3),new Uint8Array([1])));assert.throws(()=>u.cutoutBytes([1,2,3,4],new Uint8Array([1])));assert.throws(()=>u.maskBytes(new Uint8Array([255])));')

    def test_png_validation(self):
        self.run_js('''function png(w,h,type="IDAT"){const b=new Uint8Array(57),v=new DataView(b.buffer);b.set([137,80,78,71,13,10,26,10]);v.setUint32(8,13);b.set(Buffer.from("IHDR"),12);v.setUint32(16,w);v.setUint32(20,h);b.set(Buffer.from(type),37);b.set(Buffer.from("IEND"),49);return b.buffer;}assert.deepEqual(u.pngInfo(png(3,4)),{w:3,h:4});for(const b of [png(4097,1),png(2000,1001),png(0,1),png(1,1,"acTL"),new ArrayBuffer(40),png(1,1).slice(0,50)])assert.throws(()=>u.pngInfo(b));''')

    def test_csp_and_offline(self):
        html=(ROOT/'refine_prediction.html').read_text()
        code=JS.read_text()
        for directive in ["default-src 'none'", "connect-src 'none'", "script-src 'self'"]:
            self.assertIn(directive,html)
        for forbidden in ['fetch(', 'localStorage', 'XMLHttpRequest', 'WebSocket']:
            self.assertNotIn(forbidden,code)
        self.assertIn('accept=".png,image/png"',html)
        self.assertIn('修正済み予測',html)

    def test_guards_and_exports(self):
        code=JS.read_text()
        for guard in ['token!==generation', 'revision!==editRevision', '!$(\'rights\').checked', 'MAX_UNDO_BYTES', 'history.length>12', 'setPointerCapture', 'getBoundingClientRect', 'beforeunload', 'img.naturalWidth!==info.w', 'candidate.slice()', 'creature_prediction_refined_${format}_${part}_${nonce}.png']:
            self.assertIn(guard,code)
        self.assertGreaterEqual(code.count('confirm('),3)
        self.assertNotIn('gold_',code.lower())


if __name__ == '__main__':
    unittest.main()

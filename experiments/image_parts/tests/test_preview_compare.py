"""Generated binary masks and offline UI lifecycle; no artwork fixtures."""
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("node"), "Node.js required")
class PreviewCompareTests(unittest.TestCase):
    def node(self, script):
        subprocess.run(["node", "-e", script, str(ROOT / "preview_extract.js")],
                       check=True, capture_output=True, text=True, timeout=30)

    def test_equal_superset_disjoint_empty_and_immutable(self):
        self.node(r'''
const assert = require('assert/strict');
const {compareSelections: compare} = require(process.argv[1]);
for (const [a,b,expected] of [
 [[1,0,1],[1,0,1],[2,2,2,2,1,0]],
 [[1,1,0],[1,0,0],[2,1,1,2,.5,1]],
 [[1,0],[0,1],[1,1,0,2,0,2]],
 [[0,0],[0,0],[0,0,0,0,null,0]],
 [[0,0],[1,0],[0,1,0,1,0,1]],
]) {
 const x=Uint8Array.from(a), y=Uint8Array.from(b), r=compare(x,y);
 assert.deepEqual([r.fixedCount,r.adaptiveCount,r.intersection,r.union,r.iou,r.disagreementCount],expected);
 assert.deepEqual([...r.disagreement],a.map((v,i)=>v!==b[i]?1:0));
 assert.deepEqual([...x],a); assert.deepEqual([...y],b);
 r.disagreement.fill(9); assert.deepEqual([...x],a); assert.deepEqual([...y],b);
}
const old=compare(Uint8Array.of(1,0),Uint8Array.of(0,1));
compare(Uint8Array.of(1),Uint8Array.of(1));
assert.deepEqual([...old.disagreement],[1,1]);
''')

    def test_invalid_lengths_types_and_values(self):
        self.node(r'''
const assert=require('assert/strict'), {compareSelections:c}=require(process.argv[1]);
assert.throws(()=>c(new Uint8Array(1),new Uint8Array(2)));
assert.throws(()=>c([1],[1]));
assert.throws(()=>c(null,new Uint8Array()));
assert.throws(()=>c(Uint8Array.of(2),Uint8Array.of(0)));
''')

    def test_comparison_lifecycle_and_explicit_export(self):
        self.node(r'''
const assert=require('assert/strict');
const fs=require('fs'),vm=require('vm');
const ids=['rights','source','preview','export','cancel','settings','seedControls','dimensions','status','part','method','tolerance','step','drift','seedX','seedY','run','compare','comparison','comparisonStats','comparisonExport','fixedPreview','adaptivePreview','differencePreview'];
const els=Object.fromEntries(ids.map(id=>[id,{value:'',disabled:false,width:1,height:1,handlers:{},addEventListener(e,f){this.handlers[e]=f},getContext(){return {putImageData(){},drawImage(){},getImageData(){return image}}}}]));
const image={width:10,height:10,data:new Uint8ClampedArray(400)};
for(let i=0;i<100;i++)image.data.set([250,250,250,255],i*4);
for(const i of [22,23,32,33])image.data.set([40,40,40,255],i*4);
const original=Array.from(image.data);
els.rights.checked=true;els.part.value='hair';els.method.value='seeded';
els.tolerance.value='20';els.step.value='18';els.drift.value='90';els.seedX.value='2';els.seedY.value='2';
els.comparisonExport.options=[{value:''},{value:'seeded'},{value:'adaptive-seeded'}];
// Minimal valid PNG chunk structure for loader validation; decoded image is generated geometry.
const bytes=Buffer.alloc(57);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(10,16);bytes.writeUInt32BE(10,20);
bytes.write('IDAT',37);bytes.write('IEND',49);
let confirms=0, paused=null;
const sandbox={Uint8Array,Uint8ClampedArray,Uint32Array,DataView,performance,
 document:{getElementById:id=>els[id]},
 Image:class{set src(v){this.naturalWidth=10;this.naturalHeight=10;this.onload()}},
 ImageData:class{constructor(data,width,height){Object.assign(this,{data,width,height})}},
 URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},
 requestAnimationFrame:fn=>paused ? paused.push(fn) : fn(),
 window:{confirm(){confirms++;return false}}};
vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),sandbox);
(async()=>{
 els.source.files=[{name:'geometry.png',type:'image/png',size:57,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}];
 await els.source.handlers.change();
 await els.compare.handlers.click();
 assert.equal(els.comparison.hidden,false);assert.equal(els.export.disabled,true);
 assert.match(els.comparisonStats.textContent,/IoU 1.0000/);
 assert.match(els.comparisonStats.textContent,/正解との精度ではありません/);
 for(const id of ['fixedPreview','adaptivePreview','differencePreview'])assert.equal(els[id].width,10);
 els.comparisonExport.value='seeded';els.comparisonExport.handlers.change();
 assert.equal(els.export.disabled,false);assert.equal(els.comparison.hidden,false);
 await els.export.handlers.click();assert.equal(confirms,1);
 els.tolerance.handlers.input();assert.equal(els.comparison.hidden,true);assert.equal(els.comparisonExport.value,'');assert.equal(els.export.disabled,true);
 await els.run.handlers.click();assert.equal(els.export.disabled,false);
 els.drift.value='255';els.step.value='255';
 await els.compare.handlers.click();
 assert.match(els.comparisonStats.textContent,/adaptive-seeded：失敗/);
 assert.doesNotMatch(els.comparisonStats.textContent,/IoU 1/);
 assert.equal(els.comparisonExport.options[2].disabled,true);
 els.comparisonExport.value='seeded';els.comparisonExport.handlers.change();assert.equal(els.export.disabled,false);
 paused=[];const pending=els.compare.handlers.click();els.cancel.handlers.click();
 paused.shift()();await pending;
 assert.equal(els.comparison.hidden,true);assert.equal(els.export.disabled,true);
 assert.deepEqual(Array.from(image.data),original);
})().catch(e=>{console.error(e);process.exitCode=1});
''')

    def test_comparison_markup(self):
        page = (ROOT / 'preview_extract.html').read_text()
        for id_ in ('compare', 'fixedPreview', 'adaptivePreview', 'differencePreview',
                    'comparisonStats', 'comparisonExport'):
            self.assertIn(f'id="{id_}"', page)
        self.assertIn('value="">選択してください', page)
        self.assertIn('方式間の一致度であり、正解との精度ではありません', page)
        self.assertIn('grid-template-columns:repeat(auto-fit', page)

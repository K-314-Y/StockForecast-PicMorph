"""Offline Node tests with synthetic RGBA only; no artwork or browser downloads."""
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class CutoutTests(unittest.TestCase):
    def node(self, body):
        subprocess.run(['node', '-e', "const assert=require('assert/strict'); const {cutoutBytes:c,maskBytes,validatePNG}=require(process.argv[1]);\n" + body,
                       str(ROOT / 'preview_extract.js')], check=True, capture_output=True,
                       text=True, timeout=20)

    def test_fully_selected_opaque(self):
        self.node('const s=Uint8ClampedArray.of(13,71,201,255,240,80,9,255); assert.deepEqual(c(s,Uint8Array.of(1,1)),s);')

    def test_partial_transparent(self):
        self.node('assert.deepEqual([...c(Uint8ClampedArray.of(40,60,80,0,90,20,50,255),Uint8Array.of(1,0))],[40,60,80,0,0,0,0,0]);')

    def test_half_alpha_preserved_without_multiplication(self):
        self.node('assert.deepEqual([...c(Uint8ClampedArray.of(201,103,57,128),Uint8Array.of(1))],[201,103,57,128]);')

    def test_outside_rgb_and_alpha_zero(self):
        self.node('assert.deepEqual([...c(Uint8ClampedArray.of(40,60,80,255,90,20,50,128),Uint8Array.of(0,0))],Array(8).fill(0));')

    def test_inputs_immutable_and_output_fresh(self):
        self.node('''const s=Uint8ClampedArray.of(12,34,56,128), m=Uint8Array.of(1);
const a=c(s,m),b=c(s,m);assert.notEqual(a,b);assert.notEqual(a,s);
a.fill(0);assert.deepEqual([...s],[12,34,56,128]);assert.deepEqual([...m],[1]);assert.deepEqual([...b],[12,34,56,128]);''')

    def test_wrong_array_types(self):
        self.node('''for(const s of [null,[],new Uint8Array(4),new Float32Array(4)])assert.throws(()=>c(s,Uint8Array.of(1)));
for(const m of [null,[1],new Uint8ClampedArray(1),new Int8Array(1)])assert.throws(()=>c(new Uint8ClampedArray(4),m));''')

    def test_wrong_lengths_and_binary_values(self):
        self.node('''assert.throws(()=>c(new Uint8ClampedArray(3),Uint8Array.of(1)));
assert.throws(()=>c(new Uint8ClampedArray(8),Uint8Array.of(1)));
for(const v of [2,128,255])assert.throws(()=>c(new Uint8ClampedArray(4),Uint8Array.of(v)));''')

    def test_empty_and_mask_behavior_unchanged(self):
        self.node('''const a=c(new Uint8ClampedArray(),new Uint8Array());assert.ok(a instanceof Uint8ClampedArray);assert.equal(a.length,0);
assert.deepEqual([...maskBytes(Uint8Array.of(0,1))],[0,0,0,0,255,255,255,255]);''')

    def test_large_geometry_with_existing_import_bounds(self):
        self.node('''function png(w,h){const b=Buffer.alloc(57);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.writeUInt32BE(13,8);b.write('IHDR',12);b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);b.write('IDAT',37);b.write('IEND',49);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)}
assert.deepEqual(validatePNG(png(2000,1000)),{width:2000,height:1000});
for(const [w,h] of [[2001,1000],[4097,1],[4096,4096]])assert.throws(()=>validatePNG(png(w,h)));
const s=new Uint8ClampedArray(2000000*4),m=new Uint8Array(2000000);s.set([9,8,7,128],s.length-4);m[m.length-1]=1;
const out=c(s,m);assert.equal(out.length,s.length);assert.deepEqual([...out.slice(-4)],[9,8,7,128]);assert.equal(out[0],0);''')

    def test_export_lifecycle_both_formats_and_async_cancellation(self):
        # Synthetic rectangle DOM harness; no real PNG artwork or browser required.
        body = r'''
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
'''
        body = body.replace("'rights','source'", "'exportFormat','rights','source'")
        body = body.replace("let confirms=0, paused=null;", "let confirms=0, paused=null, accept=false, pendingBlob=null, downloads=[]; els.exportFormat.value='mask';")
        body = body.replace("document:{getElementById:id=>els[id]}", """document:{getElementById:id=>els[id],body:{append(){}},createElement(tag){
 if(tag==='canvas')return {getContext(){return {putImageData(data){assert.equal(data.width,10);assert.equal(data.height,10);if(els.exportFormat.value==='cutout')assert.deepEqual([...data.data.slice(88,92)],[40,40,40,255]);else assert.deepEqual([...data.data.slice(88,92)],[255,255,255,255]);}}},toBlob(fn){pendingBlob=fn}};
 return {click(){downloads.push(this.download)},remove(){}};}}""")
        body = body.replace("window:{confirm(){confirms++;return false}}", "crypto:{randomUUID:()=> 'test'},setTimeout(){},window:{confirm(message){assert.match(message,/mask|cutout/);confirms++;return accept}}")
        body = body.replace("await els.export.handlers.click();assert.equal(confirms,1);", """await els.export.handlers.click();assert.equal(confirms,1);assert.equal(downloads.length,0);
 els.exportFormat.value='cutout';els.exportFormat.handlers.change();assert.equal(els.comparisonExport.value,'seeded');assert.equal(els.export.disabled,false);
 accept=true;
 for(const format of ['mask','cutout']){els.exportFormat.value=format;els.exportFormat.handlers.change();const p=els.export.handlers.click();pendingBlob({});await p;assert.match(downloads.at(-1),new RegExp('^creature_prediction_'+format+'_hair_seeded_x2_y2_t20_'));assert.match(els.status.textContent,new RegExp(format));}
 const p=els.export.handlers.click();els.exportFormat.value='mask';els.exportFormat.handlers.change();els.exportFormat.value='cutout';els.exportFormat.handlers.change();pendingBlob({});await p;assert.equal(downloads.length,2);
 const q=els.export.handlers.click();els.cancel.handlers.click();pendingBlob({});await q;assert.equal(downloads.length,2);assert.equal(els.export.disabled,true);
 await els.compare.handlers.click();els.exportFormat.value='mask';els.exportFormat.handlers.change();assert.equal(els.comparisonExport.value,'');assert.equal(els.export.disabled,true);
 els.comparisonExport.value='seeded';els.comparisonExport.handlers.change();
 const r=els.export.handlers.click();els.rights.checked=false;els.rights.handlers.change();pendingBlob({});await r;assert.equal(downloads.length,2);assert.equal(els.export.disabled,true);
 els.rights.checked=true;await els.source.handlers.change();await els.compare.handlers.click();els.comparisonExport.value='seeded';els.comparisonExport.handlers.change();accept=false;""")
        # Harness supplies its own declarations, so invoke it directly.
        subprocess.run(['node', '-e', body, str(ROOT / 'preview_extract.js')],
                       check=True, capture_output=True, text=True, timeout=20)


if __name__ == '__main__':
    unittest.main()

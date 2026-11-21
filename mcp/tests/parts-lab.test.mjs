import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createGameServer} from '../../game_runtime/server.mjs';
import {checkOverlayHeader,hasOverlayAlpha,overlayRect}
  from '../../game_runtime/parts-lab/accessory-overlay.mjs';

const pagePath = new URL('../../game_runtime/parts-lab/preview.html',import.meta.url);
const scriptPath = new URL('../../game_runtime/parts-lab/preview.js',import.meta.url);
const html = await readFile(pagePath,'utf8');
const script = await readFile(scriptPath,'utf8');

test('local PNG parts lab has independently accessible, fixed-path, safe read-only pages',async()=>{
  const server=createGameServer();
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  try {
    const root='http://127.0.0.1:'+server.address().port;
    for (const [path,mime,data] of [
      ['/parts-lab/preview.html','text/html; charset=utf-8',Buffer.from(html)],
      ['/parts-lab/preview.js','text/javascript; charset=utf-8',Buffer.from(script)],
      ['/parts-lab/accessory-overlay.mjs','text/javascript; charset=utf-8',
        await readFile(new URL('../../game_runtime/parts-lab/accessory-overlay.mjs',import.meta.url))],
    ]) {
      const res=await fetch(root+path);
      assert.equal(res.status,200,path);
      assert.equal(res.headers.get('content-type'),mime);
      assert.equal(res.headers.get('x-content-type-options'),'nosniff');
      assert.equal(res.headers.get('cache-control'),'no-store');
      assert.equal(res.headers.get('x-frame-options'),'DENY');
      assert.equal(res.headers.get('cross-origin-resource-policy'),'same-origin');
      const csp=res.headers.get('content-security-policy');
      assert.match(csp,/default-src 'none'/);
      assert.match(csp,/script-src 'self'/);
      assert.match(csp,/connect-src 'self'/);
      assert.match(csp,/frame-ancestors 'none'/);
      assert.match(csp,/form-action 'none'/);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()),data);
      for (const method of ['POST','HEAD','PUT']) {
        const rejected=await fetch(root+path,{method});
        assert.equal(rejected.status,404,path+' '+method);
      }
    }
    for (const bad of [
      '/parts-lab/', '/parts-lab/nope.js','/parts-lab/../../local_state/secrets',
      '/parts-lab/%70review.html', '/parts-lab/%2e%2e%2flocal_state%2fsecret',
      '/parts-lab/preview.html%2f..%2fprivate','/parts-lab/preview.js/extra',
    ]) {
      const res=await fetch(root+bad,{redirect:'manual'});
      assert.notEqual(res.status,200,bad);
    }
  } finally {await new Promise(resolve=>server.close(resolve));}
});
test('PNG parts UI requires explicit local input, preserves privacy and accessible controls',()=>{
  for (const id of [
    'partBase','partReady','partHappy','partCautious','partOutfit','partHair',
    'loadOwn','loadSample','clear','frames','fps','mood','pause',
    'previewCanvas','stage','status','faceX','faceY','frameInfo',
  ]) {
    assert.match(html,new RegExp('id="'+id+'"'),id);
  }
  assert.match(html,/accept="image\/png,image\/webp"/);
  assert.match(html,/残したい重ね絵は装備ごとに再アップロードしてください/);
  assert.match(html,/再添付していない重ね絵は新しい画像から消えます/);
  assert.match(html,/体と同じサイズ/);
  assert.match(html,/6コマなら6枚を横一列に並べ/);
  assert.match(html,/href="\/game"/);
  assert.doesNotMatch(html,/<form\b/);
  assert.doesNotMatch(html,/<script(?![^>]*src)/);
  assert.doesNotMatch(script,/localStorage|sessionStorage|indexedDB/);
  assert.match(script,/fetch\('\/api\/imported-characters\/register'/);
  assert.match(html,/id="registerZip"[^>]*disabled/);
  assert.doesNotMatch(script,/\bXMLHttpRequest\b|sendBeacon\b/);
  assert.match(script,/createImageBitmap\(file\)/);
  assert.match(script,/bitmap\.close\(\)/);
  // A new ZIP must clear the old sprite before its archive validation can fail.
  assert.match(script,/async function importCharacterZip\(file\)\{[\s\S]*?resetPack\(\);[\s\S]*?extractCharacterZip\(file\)/);
  assert.match(script,/MAX_BYTES = 5 \* 1024 \* 1024/);
  assert.match(script,/MAX_FRAME_SIDE = 1024/);
  assert.match(script,/getImageData\(0,0,1,1\)/);
  assert.match(script,/document\.addEventListener\('visibilitychange'/);
  assert.match(script,/prefers-reduced-motion/);
  assert.match(script,/requestAnimationFrame/);
  assert.match(script,/if \(reduced\.matches\) \{\s*frame = 0;\s*paint\(\);\s*return;/);
});
test('the only game entrypoint is an opt-in link inside the appearance studio',async()=>{
  const game=await readFile(new URL('../../game_runtime/demo.html',import.meta.url),'utf8');
  const studio=game.split('id="appearanceStudio"')[1].split('id="predictionStudio"')[0];
  assert.match(studio,/href="\/parts-lab\/preview.html"/);
  assert.match(studio,/rel="noopener noreferrer"/);
  assert.match(studio,/SAVEもアップロードも行いません/);
  assert.doesNotMatch(game.split('id="frontCharacter"')[1].split('id="simpleHome"')[0],/parts-lab\/preview/);
});

test('accessory preflight bounds PNG and WebP dimensions before decode and checks real format',()=>{
  const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGMMqFjAwMDAxMDAwMDAAAAQugFsZnyF3gAAAABJRU5ErkJggg==','base64')).buffer;
  checkOverlayHeader(png,'image/png');
  assert.throws(()=>checkOverlayHeader(png,'image/webp'),/静止PNG/);
  assert.throws(()=>checkOverlayHeader(png.slice(0,40),'image/png'),/静止PNG/);
  new DataView(png).setUint32(16,1025);
  assert.throws(()=>checkOverlayHeader(png,'image/png'),/1024px/);

  // A VP8L header with no pixel data. This is preflight, before browser decode.
  const webp=Uint8Array.from(Buffer.from('RIFF\x12\0\0\0WEBPVP8L\x05\0\0\0\x2f\0\0\0\0\0','latin1')).buffer;
  checkOverlayHeader(webp,'image/webp');
  new DataView(webp).setUint32(21,1024,true);
  assert.throws(()=>checkOverlayHeader(webp,'image/webp'),/1024px/);
  new Uint8Array(webp).set(Buffer.from('ANIM'),12);
  assert.throws(()=>checkOverlayHeader(webp,'image/webp'),/静止PNG/);
});

test('accessory alpha requires visible content and a transparent background',()=>{
  const pixels=new Uint8ClampedArray(40);
  assert.equal(hasOverlayAlpha(pixels),false);
  pixels.fill(255);
  assert.equal(hasOverlayAlpha(pixels),false);
  pixels[3]=32;
  assert.equal(hasOverlayAlpha(pixels),true);
});

test('accessory transform clamps position and scale while preserving frame bounds',()=>{
  const bitmap={width:20,height:10};
  assert.deepEqual(overlayRect(100,60,{bitmap,x:0,y:0,scale:100}),[40,25,20,10]);
  assert.deepEqual(overlayRect(100,60,{bitmap,x:999,y:-999,scale:999}),[60,0,40,20]);
  assert.deepEqual(overlayRect(100,60,{bitmap,x:NaN,y:NaN,scale:-999}),[48,29,5,3]);
  assert.deepEqual(overlayRect(32,64,{bitmap:{width:1024,height:2},x:100,y:100,scale:200}),
    [0,63,32,1]);
});

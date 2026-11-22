import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import {createGameServer} from '../../game_runtime/server.mjs';

const pagePath = new URL('../../game_runtime/parts-lab/preview.html',import.meta.url);
const scriptPath = new URL('../../game_runtime/parts-lab/preview.js',import.meta.url);
const html = await readFile(pagePath,'utf8');
const script = await readFile(scriptPath,'utf8');
const zipImporter = await readFile(new URL('../../game_runtime/parts-lab/zip-import.mjs',import.meta.url),'utf8');

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
      ['/parts-lab/zip-import.mjs','text/javascript; charset=utf-8',Buffer.from(zipImporter)],
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
      '/parts-lab/preview.html%2f..%2fprivate','/parts-lab/preview.js/extra', '/parts-lab/zip-import.mjs/extra',
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
    'previewCanvas','stage','status','faceX','faceY','frameInfo','demoList','demoStatus','cancelDemo',
  ]) {
    assert.match(html,new RegExp('id="'+id+'"'),id);
  }
  assert.match(html,/accept="image\/png,image\/webp"/);
  assert.match(html,/画像はブラウザ内だけで使い、アップロードも保存もしません/);
  assert.match(html,/体と同じサイズ/);
  assert.match(html,/6コマなら6枚を横一列に並べ/);
  assert.match(html,/href="\/game"/);
  assert.doesNotMatch(html,/<form\b/);
  assert.doesNotMatch(html,/<script(?![^>]*src)/);
  assert.doesNotMatch(script,/localStorage|sessionStorage|indexedDB/);
  // Gallery fetches only its local catalog and four fixed PNG roles, all via GET.
  assert.deepEqual(script.match(/['"]\/api\/[^'"]+['"]/g).sort(),["'/api/character-demos'","'/api/character-equipment/v1'","'/api/independent-parts'"]);
  assert.match(script,/fetch\(url,\{mode:'same-origin',method:'GET',cache:'no-store',redirect:'error',signal\}\)/);
  assert.match(script,/fetchDemo\(DEMOS_API,request\.signal\)/);
  assert.match(script,/fetchDemo\(DEMOS_API\+'\/'\+item\.generated_id\+'\/'\+part\+'\.png'/);
  assert.deepEqual(script.match(/\bPOST\b/g),['POST']);
  assert.match(script,/fetch\(url,\{method:'POST'.*\n.*expected_revision:demo\.revision/);
  assert.doesNotMatch(script,/\b(?:PUT|PATCH|DELETE)\b|innerHTML|document\.cookie/);
  assert.doesNotMatch(script,/\bXMLHttpRequest\b|sendBeacon\b/);
  assert.match(script,/createImageBitmap\(file\)/);
  assert.match(script,/bitmap\.close\(\)/);
  assert.match(script,/MAX_BYTES = 5 \* 1024 \* 1024/);
  assert.match(script,/MAX_FRAME_SIDE = 1024/);
  assert.match(script,/getImageData\(0,0,1,1\)/);
  assert.match(script,/document\.addEventListener\('visibilitychange'/);
  assert.match(script,/prefers-reduced-motion/);
  assert.match(script,/requestAnimationFrame/);
  assert.match(script,/if \(reduced\.matches\) \{\s*frame = 0;\s*paint\(\);\s*return;/);
});
test('generated 3-by-2 character sheets are opt-in and converted locally to six synchronized layers',()=>{
  assert.match(html,/id="generatedStudio"/);
  assert.match(html,/3列×2行＝6コマ/);
  for(const id of ['generatedBase','generatedReady','generatedHappy','generatedCautious','loadGenerated']){
    assert.match(html,new RegExp('id="'+id+'"'),id);
  }
  assert.match(script,/generatedSheetGeometry\(bitmap\)/);
  assert.match(script,/GRID_COLUMNS=3, GRID_ROWS=2, TARGET_CELL=256/);
  assert.match(script,/bitmap\.width \/ GRID_COLUMNS !== bitmap\.height \/ GRID_ROWS/);
  assert.match(script,/createImageBitmap\(strip\)/);
  assert.match(script,/if\(name!=='base'&&!hasAlpha\(image\)\)/);
  assert.match(script,/displayLoaded\(next,6\)/);
  assert.match(script,/status\('生成したキャラの6コマを合成しました/);
  assert.match(script,/if\(myEpoch!==epoch\)return/);
  assert.match(script,/\+\+epoch;resetPack\(\);setBusy\(false\)/);
  assert.doesNotMatch(script,/\bFileReader\b|localStorage|indexedDB|sendBeacon\(/);
  assert.doesNotMatch(html,/<form\b/);
});

test('one ZIP file auto-loads body and mood images without uploads',()=>{
  assert.match(html,/id="zipFile" type="file"/);
  assert.match(html,/class="panel preview-panel" aria-labelledby="previewTitle"/);
  assert.match(html,/@media\(max-width:750px\)\{[^}]*\}\.preview-panel\{order:-1\}/);
  assert.match(html,/ZIPを1回選ぶだけ/);
  assert.match(script,/extractCharacterZip\(file\)/);
  assert.match(script,/displayLoaded\(next,6\)/);
  assert.match(script,/zipFile'\)\.addEventListener\('change'/);
  assert.match(zipImporter,/DecompressionStream\('deflate-raw'\)/);
  assert.match(zipImporter,/crc32\(out\)!==item\.checksum/);
  assert.match(zipImporter,/MAX_ZIP_BYTES=12\*1024\*1024/);
  assert.doesNotMatch(zipImporter,/localStorage|indexedDB|sendBeacon/);
});

test('the only game entrypoint is an opt-in link inside the appearance studio',async()=>{
  const game=await readFile(new URL('../../game_runtime/demo.html',import.meta.url),'utf8');
  const studio=game.split('id="appearanceStudio"')[1].split('id="predictionStudio"')[0];
  assert.match(studio,/href="\/parts-lab\/preview.html"/);
  assert.match(studio,/rel="noopener noreferrer"/);
  assert.match(studio,/SAVEもアップロードも行いません/);
  assert.doesNotMatch(game.split('id="frontCharacter"')[1].split('id="simpleHome"')[0],/parts-lab\/preview/);
});

function previewRuntime(extra={}) {
  const elements=new Map();
  const draws=[];
  const context=createContext({
    document:{getElementById(id){
      if(!elements.has(id)) elements.set(id,{
        dataset:{},value:id==='mood'?'ready':'0',addEventListener(){},replaceChildren(){},
        getContext(){return {clearRect(){},drawImage(...args){draws.push(args);}};},
      });
      return elements.get(id);
    },addEventListener(){}},
    window:{matchMedia(){return {matches:false,addEventListener(){}};},addEventListener(){}},
    fetch:()=>new Promise(()=>{}),AbortController,setTimeout:()=>0,
    ...extra,
  });
  const run=source=>runInContext(source,context);
  run(script);
  return {context,run,draws,elements};
}

function pngHeader(width,height,chunk='IDAT') {
  // A small header fixture for the pre-decode check. Browser decoding is
  // responsible for validating compressed pixels and realizing the bitmap.
  const bytes=Buffer.alloc(57);
  bytes.writeUInt32BE(0x89504e47);bytes.writeUInt32BE(0x0d0a1a0a,4);
  bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);
  bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);
  bytes.write(chunk,37);bytes.write('IEND',49);
  return bytes.buffer;
}

test('independent files are opt-in and checked before browser decode',()=>{
  assert.match(html,/独立パーツのプレビュー/);
  assert.match(html,/未保存・ゲーム登録されない/);
  assert.match(html,/id="independentFiles"[^>]+multiple disabled/);
  const {context,run}=previewRuntime();
  context.png=pngHeader(192,208);
  assert.equal(run("independentImageSize(png,'image/png').frames"),1);
  context.png=pngHeader(1152,208);
  assert.equal(run("independentImageSize(png,'image/png').frames"),6);
  context.png=pngHeader(384,208);
  assert.throws(()=>run("independentImageSize(png,'image/png')"),/192×208/);
  context.png=pngHeader(192,208,'acTL');
  assert.throws(()=>run("independentImageSize(png,'image/png')"),/アニメーション/);
  assert.throws(()=>run("independentImageSize(png,'image/webp')"),/正常な透過PNG/);

  const extended=Buffer.alloc(30);
  extended.write('RIFF');extended.writeUInt32LE(22,4);extended.write('WEBPVP8X',8);
  extended.writeUInt32LE(10,16);extended[20]=16;
  extended.writeUIntLE(191,24,3);extended.writeUIntLE(207,27,3);
  context.webp=extended.buffer;
  assert.equal(run("independentImageSize(webp,'image/webp').frames"),1);
  extended[20]|=2;
  assert.throws(()=>run("independentImageSize(webp,'image/webp')"),/アニメーション/);
});

test('independent layers keep order, frame alignment and offsets across expressions',()=>{
  const {run,draws,elements}=previewRuntime();
  run(`pack={width:192,height:208,frames:6,images:{base:'body',outfit:'outfit',ready:'ready',happy:'happy',hair:'hair'}};
    frame=3;
    independentParts.push(
      {bitmap:'fixed',anchor:'base',frames:1,visible:true,x:7,y:-4},
      {bitmap:'atlas',anchor:'outfit',frames:6,visible:true,x:0,y:0},
      {bitmap:'blind',anchor:'face',frames:1,visible:false},
      {bitmap:'above face',anchor:'face',frames:1,visible:true,x:0,y:0},
      {bitmap:'first',anchor:'hair',frames:6,visible:true,x:0,y:0},
      {bitmap:'last',anchor:'hair',frames:1,visible:true,x:0,y:0});
    paint();`);
  assert.deepEqual(draws.map(([name])=>name),['body','fixed','outfit','atlas','ready','above face','hair','first','last']);
  assert.deepEqual(draws[1],['fixed',0,0,192,208,7,-4,192,208]);
  assert.equal(draws[3][1],3*192);
  elements.get('mood').value='happy';
  draws.length=0;
  run('paint()');
  assert.equal(draws[4][0],'happy');
  assert.deepEqual(draws[1].slice(5,7),[7,-4]);
  draws.length=0;
  run('pack.width=256;paint()');
  assert.deepEqual(draws.map(([name])=>name),['body','outfit','happy','hair']);
});

test('clearing an in-flight independent read closes late bitmaps and keeps the list empty',async()=>{
  let releaseDecode,decodeStarted;
  const decoding=new Promise(resolve=>{decodeStarted=resolve;});
  const {context,run,elements}=previewRuntime({createImageBitmap(){
    decodeStarted();
    return new Promise(resolve=>{releaseDecode=resolve;});
  }});
  context.file={name:'fixture.png',size:57,type:'image/png',arrayBuffer:async()=>pngHeader(192,208)};
  const task=run('pack={width:192,height:208,frames:6};loadIndependentParts([file])');
  await decoding;
  assert.equal(elements.get('independentFiles').disabled,true);
  run('clearIndependentParts()');
  let closed=0;
  releaseDecode({width:192,height:208,close(){closed++;}});
  await task;
  assert.equal(closed,1);
  assert.equal(run('independentParts.length'),0);
  assert.equal(run('independentLoad'),undefined);
  assert.equal(elements.get('cancelIndependent').hidden,true);
});

test('saved part loads its selected URL only and a late decode closes after clear',async()=>{
  const requests=[];
  const {context,run}=previewRuntime({clearTimeout(){},Blob});
  context.entry={part_id:'pt_'+'a'.repeat(32),kind_id:'creator.ribbon',layer_anchor:'outfit',image_sha256:'b'.repeat(64)};
  context.atlas=new Uint8Array(pngHeader(1152,208));
  context.track=(url,sha,signal)=>requests.push({url,sha,signal});
  run(`savedPartResponse=async (url,mime,limit,signal,sha)=>{track(url,sha,signal);return atlas;};
    pack={width:256,height:256,frames:6};`);
  await run('equipSavedPart(entry)');
  assert.equal(requests.length,0);
  let release,started,closed=0;
  const decoding=new Promise(resolve=>{started=resolve;});
  context.createImageBitmap=()=>{started();return new Promise(resolve=>{release=resolve;});};
  const work=run('pack={width:192,height:208,frames:6};equipSavedPart(entry)');
  await decoding;
  assert.equal(requests[0].url,'/api/independent-parts/'+context.entry.part_id+'/part.png');
  assert.equal(requests[0].sha,context.entry.image_sha256);
  run('clearIndependentParts()');
  assert.equal(requests[0].signal.aborted,true);
  release({width:1152,height:208,close(){closed++;}});
  await work;
  assert.equal(closed,1);
  assert.equal(run('independentParts.length'),0);
});

test('equipment restore discards every staged bitmap on error or character switch',async()=>{
  const {context,run,elements}=previewRuntime({clearTimeout(){},TextDecoder});
  const part={part_id:'pt_'+'a'.repeat(32),layer_anchor:'face',x:-4,y:22,visible:false,image_sha256:'b'.repeat(64)};
  const id='cp_'+'c'.repeat(32);
  context.equipmentBytes=new TextEncoder().encode(JSON.stringify({schema:1,character_id:id,revision:5,
    parts:[part,{...part,part_id:'pt_'+'d'.repeat(32)}]}));
  context.id=id;
  run(`pack={width:192,height:208,frames:6};registeredDemo={id,name:'Fixture',revision:1};
    savedPartResponse=async ()=>equipmentBytes;independentParts.push({catalogId:'original'});`);
  let calls=0,closed=0;
  context.decode=async()=>{if(++calls===2)throw Error('corrupt PNG');return {close(){closed++;}};};
  run('decodeSavedPart=decode');
  await run("equipmentAction('restore')");
  assert.equal(closed,1);
  assert.equal(run('independentParts[0].catalogId'),'original');
  assert.equal(run('registeredDemo.revision'),1);
  assert.match(elements.get('equipmentStatus').textContent,/復元できません/);
  let started,resume;
  const decoding=new Promise(resolve=>{started=resolve;});
  context.decode=()=>{started();return new Promise(resolve=>{resume=resolve;});};
  run('decodeSavedPart=decode');
  const pending=run("equipmentAction('restore')");
  await decoding;
  run(`cancelEquipmentRequest();registeredDemo={id:'cp_'+'e'.repeat(32),name:'Next',revision:0};`);
  resume({close(){closed++;}});
  await pending;
  assert.equal(closed,2);
  assert.equal(run('registeredDemo.revision'),0);
  assert.equal(run('independentParts[0].catalogId'),'original');
});

test('late equipment save acknowledgements cannot change another character revision',async()=>{
  const {context,run,elements}=previewRuntime({clearTimeout(){},TextDecoder});
  const id='cp_'+'a'.repeat(32);
  context.id=id;
  context.equipmentBytes=new TextEncoder().encode(JSON.stringify({schema:1,character_id:id,revision:2,parts:[]}));
  let response,request;
  context.fetch=(url,options)=>{request={url,options};return new Promise(resolve=>{response=resolve;});};
  run(`pack={width:192,height:208,frames:6};registeredDemo={id,name:'Original',revision:1};
    boundedPartResponse=async()=>equipmentBytes;`);
  const pending=run("equipmentAction('save')");
  assert.equal(request.url,'/api/character-equipment/v1/'+id);
  assert.equal(request.options.method,'POST');
  assert.deepEqual(JSON.parse(request.options.body),{expected_revision:1,parts:[]});
  run(`cancelEquipmentRequest();registeredDemo={id:'cp_'+'b'.repeat(32),name:'Next',revision:0};`);
  assert.equal(request.options.signal.aborted,true);
  response({});
  await pending;
  assert.equal(run('registeredDemo.revision'),0);
  assert.equal(elements.get('equipmentStatus').textContent,'');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,copyFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createGameServer} from '../../game_runtime/server.mjs';
import {createUserPngImporter} from '../../game_runtime/user-png-import.mjs';
import {createActiveCharacterStore} from '../../game_runtime/active-character.mjs';
const run=promisify(execFile);
let pngFixture;
async function fixture() {
  if(!pngFixture) {
    const script=[
      'import io,base64,json',
      'from PIL import Image,ImageDraw',
      'result={}',
      "for i,key in enumerate(['body','ready','happy','cautious']):",
      " im=Image.new('RGBA',(1152,208),(0,0,0,0))",
      ' d=ImageDraw.Draw(im)',
      ' for frame in range(6):',
      '  x=frame*192',
      "  if key=='body':",
      '   d.ellipse((x+38,17,x+154,187),fill=(123,110,200,255))',
      '  else:',
      '   d.ellipse((x+76,78,x+92,90),fill=(60,30+i*10,50,255))',
      ' out=io.BytesIO()',
      " im.save(out,format='PNG')",
      ' result[key]=base64.b64encode(out.getvalue()).decode()',
      'print(json.dumps(result))',
    ].join('\n');
    const {stdout}=await run('python3',['-B','-c',script],{maxBuffer:5000000});
    pngFixture=JSON.parse(stdout);
  }
  return {name:'PNG試作',parts:pngFixture};
}
async function setup(t,importerOverride) {
  const dir=await mkdtemp(join(tmpdir(),'creature-userpng-test-'));
  await mkdir(join(dir,'mcp'));
  for(const name of ['import_png_character.py','character_parts.py','character_parts_render.py']) {
    await copyFile(new URL('../'+name,import.meta.url),join(dir,'mcp',name));
  }
  const catalogRoot=join(dir,'local_state','character_parts');
  const userPngImporter=importerOverride===undefined ?
    createUserPngImporter({script:join(dir,'mcp','import_png_character.py')}) : importerOverride;
  const server=createGameServer({
    catalogRoot,userPngImporter,
    activeCharacterStore:createActiveCharacterStore({file:join(dir,'local_state','node_game','active-character.json')}),
    loadSnapshot:()=>{throw Error('Never touch prediction model');},
  });
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const url='http://127.0.0.1:'+server.address().port;
  const post=(input,headers={})=>fetch(url+'/api/character-demos/import',{method:'POST',
    headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(input)});
  return {url,post,dir,catalogRoot};
}
test('user PNG registers into private verified catalog; active visual unchanged',async t=>{
  const {url,post,catalogRoot}=await setup(t);
  const original=await(await fetch(url+'/api/active-character')).json();
  const capability=await(await fetch(url+'/api/character-demos/import')).json();
  assert.equal(capability.available,true);
  const response=await post(await fixture(),{Origin:url});
  assert.equal(response.status,201);
  const created=await response.json();
  assert.match(created.generated_id,/^cp_[a-f0-9]{32}$/);
  assert.equal(created.name,'PNG試作');
  assert.equal(created.engine,'user-png');
  assert.equal(created.registered,true);
  const list=await(await fetch(url+'/api/character-demos')).json();
  assert.equal(list.length,1);
  assert.equal(list[0].generated_id,created.generated_id);
  assert.equal(list[0].engine,'user-png');
  for(const kind of ['body','ready','happy','cautious']) {
    const image=await fetch(url+'/api/character-demos/'+created.generated_id+'/'+kind+'.png');
    assert.equal(image.status,200);
    assert.equal(image.headers.get('content-type'),'image/png');
    assert((await image.arrayBuffer()).byteLength>0);
  }
  assert.deepEqual(await(await fetch(url+'/api/active-character')).json(),original);
  assert.match(await readFile(join(catalogRoot,created.generated_id,'demo.json'),'utf8'),/user-png/);
});
test('malformed PNG input and off-origin writes rejected',async t=>{
  const {url,post}=await setup(t,async()=>{throw Error('No importer call allowed');});
  const good=await fixture();
  const invalid=[
    {...good,name:''},{...good,name:'a'.repeat(20)},
    {...good,parts:{...good.parts,body:'!!!!'}},
    {...good,parts:{...good.parts,hidden:'ABCD'}},
    {...good,unknown:'field'},null,
  ];
  for(const payload of invalid) assert.equal((await post(payload)).status,400);
  for(const headers of [{Origin:'http://another.example'},{'Sec-Fetch-Site':'cross-site'},
    {Origin:url.replace('127.0.0.1','localhost')}]){
    assert.equal((await post(good,headers)).status,403);
  }
  assert.equal((await fetch(url+'/api/character-demos/import',{method:'PUT'})).status,404);
});
test('Windows viewer cannot register imported images',async t=>{
  const {url,post}=await setup(t,null);
  assert.equal((await(await fetch(url+'/api/character-demos/import')).json()).available,false);
  assert.equal((await post(await fixture())).status,501);
});
test('corrupted PNG is rejected even when base64 looks valid',async t=>{
  const {post}=await setup(t);
  const good=await fixture();
  const altered={...good,parts:{...good.parts,ready:Buffer.from('not a PNG').toString('base64')}};
  assert.equal((await post(altered)).status,422);
});
test('UI prioritizes PNG drop, before the optional generated template',async()=>{
  const html=await readFile(new URL('../../game_runtime/demo.html',import.meta.url),'utf8');
  const script=await readFile(new URL('../../game_runtime/png-drop-registration.mjs',import.meta.url),'utf8');
  for(const id of ['pngDropRegistration','pngCharacterName','pngDropZone','pngDropFileInput',
    'pngFileSummary','pngDropPreview','pngRegisterButton','pngImportCapability','pngImportStatus']){
    assert.equal(html.match(new RegExp('id="'+id+'"','g'))?.length,1,id);
  }
  assert(html.indexOf('id="pngDropZone"')<html.indexOf('id="avatarRegistration"'));
  assert.match(html,/PNGをドラッグ＆ドロップして登録/);
  assert.match(script,/dataTransfer\.files/);
  assert.match(script,/extractCharacterZip/);
  assert.match(script,/canvas\.toBlob/);
  assert.match(script,/method:'POST'/);
  assert.doesNotMatch(script,/localStorage|sessionStorage|indexedDB/);
});

test('prepared PNG/WebP part library and body/face/hair/outfit input slots are exposed',async()=>{
  const html=await readFile(new URL('../../game_runtime/demo.html',import.meta.url),'utf8');
  const script=await readFile(new URL('../../game_runtime/png-drop-registration.mjs',import.meta.url),'utf8');
  const zip=await readFile(new URL('../../game_runtime/parts-lab/zip-import.mjs',import.meta.url),'utf8');
  for(const id of ['pngUsePreparedParts','pngPartsByRole','pngLoadChosenParts',
    'pngRoleBody','pngRoleReady','pngRoleHappy','pngRoleCautious','pngRoleOutfit','pngRoleHair']){
    assert.equal(html.match(new RegExp('id="'+id+'"','g'))?.length,1,id);
  }
  assert.match(html,/用意済みのHatchPet画像パーツを試す/);
  assert.match(html,/髪と服は6コマ画像でも、1コマ分の透過PNGでも使えます/);
  assert.match(script,/const OPTIONAL=\['outfit','hair'\]/);
  assert.match(script,/const PREPARED=Object\.freeze/);
  assert.match(script,/hatchpet-demo-parts-body\.webp/);
  assert.match(script,/preparedButton\.addEventListener\('click'/);
  assert.match(script,/chosenPartsButton\.addEventListener\('click'/);
  assert.match(script,/const repeatStaticOverlay=OPTIONAL\.includes\(role\)/);
  assert.match(script,/canvases\.body\.getContext\('2d'\)\.drawImage\(canvases\.outfit/);
  assert.match(script,/canvases\[role\]\.getContext\('2d'\)\.drawImage\(canvases\.hair/);
  assert.match(zip,/body\|ready\|happy\|cautious\|outfit\|hair/);
});

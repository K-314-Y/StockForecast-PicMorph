import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,mkdir,rm,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalCharacterCreator,validateRegistration} from '../../game_runtime/character-demo-creator.mjs';
import {createActiveCharacterStore} from '../../game_runtime/active-character.mjs';
import {createGameServer} from '../../game_runtime/server.mjs';

async function harness(t,creatorOption) {
  const dir=await mkdtemp(join(tmpdir(),'creature-web-register-'));
  const mcp=join(dir,'mcp');
  const catalogRoot=join(dir,'local_state','character_parts');
  await mkdir(mcp,{recursive:true});
  for(const name of ['character_parts.py','character_parts_render.py']) {
    await copyFile(new URL('../'+name,import.meta.url),join(mcp,name));
  }
  const characterCreator=creatorOption===undefined ?
    createLocalCharacterCreator({script:join(mcp,'character_parts.py')}) : creatorOption;
  const activeCharacterStore=createActiveCharacterStore({file:join(dir,'local_state','node_game','active-character.json')});
  const server=createGameServer({catalogRoot,characterCreator,activeCharacterStore,
    loadSnapshot:()=>{throw Error('Registration must not reach prediction state');}});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    await rm(dir,{recursive:true,force:true});
  });
  const origin='http://127.0.0.1:'+server.address().port;
  const endpoint=origin+'/api/character-demos/create';
  const post=(body,headers={})=>fetch(endpoint,{method:'POST',
    headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  return {origin,endpoint,post,catalogRoot,dir};
}

const appearance={name:'お花のデモ',hair_color:'#A58BD9',
  clothing_color:'#78C2C5',accessory:'star'};

test('web registration creates a procedural character, registers it, never changes the active avatar',async t=>{
  const {endpoint,origin,post,catalogRoot,dir}=await harness(t);
  const capability=await(await fetch(endpoint)).json();
  assert.deepEqual(capability.available,true);
  assert.match(capability.message,/Linux/);
  const before=await(await fetch(origin+'/api/active-character')).json();
  assert.equal(before.active_demo_id,null);
  const out=await post(appearance,{Origin:origin});
  assert.equal(out.status,201);
  assert.equal(out.headers.get('cache-control'),'no-store');
  const result=await out.json();
  assert.match(result.generated_id,/^cp_[0-9a-f]{32}$/);
  assert.equal(result.name,appearance.name);
  assert.equal(result.engine,'original-template');
  assert.equal(result.registered,true);
  const gallery=await(await fetch(origin+'/api/character-demos')).json();
  assert.equal(gallery.length,1);
  assert.equal(gallery[0].generated_id,result.generated_id);
  for(const part of ['body','ready','happy','cautious']){
    const response=await fetch(origin+'/api/character-demos/'+result.generated_id+'/'+part+'.png');
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),'image/png');
    assert((await response.arrayBuffer()).byteLength>0);
  }
  const after=await(await fetch(origin+'/api/active-character')).json();
  assert.deepEqual(after,before);
  assert.equal((await readdir(join(dir,'local_state'))).sort().join(','),'character_parts');
  const registered=JSON.parse(await readFile(join(catalogRoot,result.generated_id,'demo.json'),'utf8'));
  assert.equal(registered.visibility,'local_only');
});

test('web registration validates input strictly and rejects cross-origin callers and unsupported methods',async t=>{
  const {endpoint,post,origin}=await harness(t,async()=>{throw Error('must not run');});
  const cases=[
    {...appearance,name:' '},{...appearance,name:'X'.repeat(17)},
    {...appearance,hair_color:'red'},{...appearance,accessory:'../../etc/passwd'},
    {...appearance,seed:4},{...appearance,name:'line\nbreak'},
  ];
  for(const payload of cases)assert.equal((await post(payload)).status,400);
  for(const headers of [{Origin:'https://example.org'},{'Sec-Fetch-Site':'cross-site'},
    {'Sec-Fetch-Site':'same-site'},{Origin:origin.replace('127.0.0.1','localhost')}]){
    assert.equal((await post(appearance,headers)).status,403);
  }
  assert.equal((await fetch(endpoint,{method:'PUT'})).status,404);
  assert.equal((await fetch(endpoint,{method:'DELETE'})).status,404);
  assert.equal((await fetch(endpoint,{method:'POST',headers:{'Content-Type':'text/plain'},body:'test'})).status,415);
});

test('Windows viewer reports unavailable and never executes registration',async t=>{
  const {endpoint,post}=await harness(t,null);
  const result=await(await fetch(endpoint)).json();
  assert.equal(result.available,false);
  assert.match(result.message,/Windows/);
  assert.equal((await post(appearance)).status,501);
});

test('registered character creation has one in-flight request per local server',async t=>{
  let release;
  let count=0;
  const creator=()=>{count++;return new Promise(resolve=>{release=resolve;});};
  const {post}=await harness(t,creator);
  const first=post(appearance);
  for(let i=0;i<70 && count===0;i++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(count,1);
  const second=await post(appearance);
  assert.equal(second.status,429);
  release({generated_id:'cp_'+'a'.repeat(32),name:appearance.name,engine:'original-template'});
  assert.equal((await first).status,503); // Fake creator does not register verified PNGs.
});

test('form explicitly distinguishes registration from changing displayed avatar',async()=>{
  const html=await readFile(new URL('../../game_runtime/demo.html',import.meta.url),'utf8');
  const js=await readFile(new URL('../../game_runtime/generated-avatar.mjs',import.meta.url),'utf8');
  const server=await readFile(new URL('../../game_runtime/server.mjs',import.meta.url),'utf8');
  for(const id of ['avatarRegistration','registerCharacterForm','registerCharacterName','registerHairColor',
    'registerClothingColor','registerAccessory','registerCharacterButton',
    'registrationCapability','registrationResult']){
    assert.equal(html.match(new RegExp('id="'+id+'"','g'))?.length,1,id);
  }
  // Procedural templates remain optional; user's dropped PNG is primary.
  assert.match(html,/別機能：図形のサンプルキャラを新しく作る/);
  assert.match(html,/PNGをドラッグ＆ドロップして登録/);
  assert.ok(html.indexOf('id="pngDropRegistration"')<html.indexOf('id="avatarRegistration"'));
  assert.match(html,/キャラを生成して登録/);
  assert.match(html,/登録してもゲームの外見は自動では変わりません/);
  assert.match(js,/registrationForm\.addEventListener\('submit'/);
  assert.match(js,/json\(CATALOG\+'\/create',controller\.signal,input\)/);
  assert.match(js,/await refresh\(\)/);
  assert.match(js,/select\.value=created\.generated_id/);
  assert.match(js,/登録しました。次は下の/);
  assert.match(server,/characterCreator=null|characterCreator = process\.platform/);
});

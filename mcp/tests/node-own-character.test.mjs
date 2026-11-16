import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGameServer,pythonPredict} from '../../game_runtime/server.mjs';
import {createGrowthStore} from '../../game_runtime/growth.mjs';
import {createArtworkStore} from '../../game_runtime/artwork.mjs';
import {createCompanionStore} from '../../game_runtime/companion.mjs';

// Exercise the real request listener without opening a network port.
function request(server,path,body) {
  const bytes=body===undefined ? null : Buffer.from(JSON.stringify(body));
  const req=Readable.from(bytes ? [bytes] : []);
  req.method=bytes ? 'POST' : 'GET';req.url=path;
  req.socket={remoteAddress:'127.0.0.1'};
  req.headers={host:'localhost:8890',...(bytes ? {
    'content-type':'application/json','content-length':String(bytes.length),
  } : {})};
  return new Promise(resolve=>{
    let status;
    server.emit('request',req,{
      writeHead(code){status=code;},
      end(data){resolve({status,bytes:Buffer.from(data),json:()=>JSON.parse(data)});},
    });
  });
}
const png={mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9F7pSAAAAABJRU5ErkJggg=='};
const slots=['mine','owl','turtle'];
const solo={mine:100,owl:0,turtle:0};
const model={fast_window:3,slow_window:9,risk_fraction:.35,
  plugin_weights:{trend:100,momentum:0,volatility:0,reversion:0},
  plugin_strengths:{trend:117,momentum:83,volatility:92,reversion:105}};
const version='tv_'+'a'.repeat(32);

test('own character keeps artwork, rules, tuned models and legacy XP while all practice ignores stored gear',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'own-character-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const growthFile=join(dir,'growth.json');
  const store=createGrowthStore({file:growthFile,legacyFile:join(dir,'absent.json')});
  const legacy={schema:1,revision:7,slots:Object.fromEntries(slots.map((slot,i)=>[slot,{
    achievements:['first_practice','diversify_slots','full_allocation'],
    gear:['focus_lens','spark_charm','calm_halo'][i],
  }]))};
  const original=JSON.stringify(legacy,null,3)+'\n';await writeFile(growthFile,original);
  const artworkFile=join(dir,'artwork.json'),companionFile=join(dir,'companion.json');
  const artworkStore=createArtworkStore({file:artworkFile});
  const companionStore=createCompanionStore({file:companionFile});
  await artworkStore.save({slot:'base',image:png,expected_revision:0});
  await companionStore.save({expected_revision:0,companion:{name:'自作の相棒',hair_color:'#123456',
    clothing_color:'#abcdef',approach:'momentum',risk_percent:65}});
  const originalArtwork=await readFile(artworkFile),originalCompanion=await readFile(companionFile);
  const before=await stat(growthFile);
  const loadSnapshot=async()=>({state:{model,revision:3},lineup:{revision:2,
    slots:['owl','turtle'].map(slot=>({slot,model}))},growth:await store.public(),
    source_revision:3,lineup_revision:2,growth_revision:7});
  let observed;
  const server=createGameServer({store,artworkStore,companionStore,loadSnapshot,
    predict:async plan=>{observed=plan;return pythonPredict(plan);},
    trainedVersion:async()=>({kind:'trained_practice_only',version_id:version,
      source_draft_id:'bp_'+'b'.repeat(32),parameters_sha256:'c'.repeat(64),model})});
  server.address=()=>({port:8890});
  const growth=(await request(server,'/api/growth')).json();
  assert.equal(growth.slots[0].xp,40);
  for(const slot of growth.slots)assert.deepEqual(Object.keys(slot).sort(),['achievements','level','slot','xp']);
  const retired=await request(server,'/api/growth/equip',{
    slot:'mine',gear_id:'none',expected_growth_revision:7});
  assert.equal(retired.status,404);
  assert.equal(store.equip,undefined);
  let ticket;
  for(const [path,body,trained] of [
    ['/api/practice',{allocations:solo},false],
    ['/api/practice/preview',{allocations:solo},false],
    ['/api/practice',{allocations:solo,trained_version_id:version},true],
    ['/api/practice/preview',{allocations:solo,trained_version_id:version},true],
    ['/api/quick-practice',{model_id:'self',amount:1000},false],
    ['/api/compare',{contenders:{mine:'self',owl:version,turtle:'preset'}},false],
  ]) {
    const response=await request(server,path,body);
    assert.equal(response.status,200,response.bytes.toString());
    if(response.json().training_ticket)ticket=response.json().training_ticket;
    for(const slot of slots)assert.deepEqual(observed.models[slot].plugin_strengths,model.plugin_strengths);
    assert.equal(observed.models.mine.risk_fraction,trained ? .35 : .65);
    assert.deepEqual(observed.models.mine.plugin_weights,trained ? model.plugin_weights :
      {trend:0,momentum:100,volatility:0,reversion:0});
  }
  const claimed=await request(server,'/api/training/complete',{ticket,expected_growth_revision:7});
  assert.equal(claimed.status,200);
  assert.deepEqual(claimed.json().earned_xp,{mine:0});
  assert.equal((await request(server,'/api/training/complete',{ticket,expected_growth_revision:7})).status,409);
  const image=await request(server,'/api/artwork/image/base');
  assert.equal(image.status,200);
  assert.deepEqual(image.bytes,Buffer.from(png.base64,'base64'));
  assert.equal((await request(server,'/api/artwork')).json().slots.base.exists,true);
  assert.equal(await readFile(growthFile,'utf8'),original);
  assert.equal((await stat(growthFile)).mtimeMs,before.mtimeMs);
  assert.deepEqual(await readFile(artworkFile),originalArtwork);
  assert.deepEqual(await readFile(companionFile),originalCompanion);
});

test('retired MCP registration is absent and growth descriptions mention only records',async()=>{
  const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/equip_creature_gear|\/api\/growth\/equip/);
  assert.match(source,/registerTool\("set_eye"/);
  for(const path of ['../server.mjs','../companion-chatgpt.mjs']) {
    const text=await readFile(new URL(path,import.meta.url),'utf8');
    const block=text.slice(text.indexOf(path.includes('companion') ? "registerTool('get_my_creature_growth'" : 'server.registerTool("get_creature_growth"'));
    assert.doesNotMatch(block.slice(0,block.indexOf('inputSchema')),/装備|gear/);
  }
});

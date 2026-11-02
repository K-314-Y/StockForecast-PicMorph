import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, lstat, writeFile, symlink} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCompanionStore, validateCompanion, applyCompanion, APPROACHES} from '../../game_runtime/companion.mjs';
import {createGameServer, pythonPredict} from '../../game_runtime/server.mjs';
import {runSyntheticGame} from '../../game_runtime/practice.mjs';

const c = {name:'<b>ミオ</b>',hair_color:'#ABCDEF',clothing_color:'#FEDCBA',approach:'reversion',risk_percent:75};
const model = {fast_window:3,slow_window:9,risk_fraction:.35,
  plugin_weights:{trend:100,momentum:0,reversion:0,volatility:0},
  plugin_strengths:{trend:100,momentum:100,reversion:100,volatility:100}};
const snapshot = () => ({state:{model},lineup:{slots:[{slot:'owl',model},{slot:'turtle',model}]},
  growth:{slots:['mine','owl','turtle'].map(slot=>({slot,gear:'none'}))},
  source_revision:1,lineup_revision:2,growth_revision:3});
const allocations = {mine:100,owl:0,turtle:0};
async function isolated(fn) {
  const dir = await mkdtemp(join(tmpdir(),'companion-test-'));
  const file = join(dir,'node_game','companion.json');
  const store = createCompanionStore({file});
  try {await fn({store,file,dir});} finally {await rm(dir,{recursive:true,force:true});}
}
async function serve(store, options, fn) {
  const server = createGameServer({companionStore:store,loadSnapshot:async()=>snapshot(),...options});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {await fn('http://127.0.0.1:'+server.address().port);}
  finally {await new Promise(r=>server.close(r));}
}
const post = (url,path,body)=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

test('companion GET default is read-only; normalized save restores without touching legacy files',async()=>isolated(async({store,file,dir})=>{
  const legacy=join(dir,'growth.json');await writeFile(legacy,'legacy sentinel');
  await serve(store,{},async url=>{
    const initial=await (await fetch(url+'/api/companion')).json();
    assert.equal(initial.revision,0);assert.equal(initial.created,false);
    assert.deepEqual(await readdir(dir),['growth.json']);
    const saved=await post(url,'/api/companion',{expected_revision:0,companion:c});
    assert.equal(saved.status,200);
    const value=await saved.json();
    assert.equal(value.companion.hair_color,'#abcdef');assert.equal(value.revision,1);
    assert.deepEqual(await createCompanionStore({file}).read(),value);
    const stale=await post(url,'/api/companion',{expected_revision:0,companion:c});
    assert.equal(stale.status,409);
  });
  assert.equal(await readFile(legacy,'utf8'),'legacy sentinel');
  assert.deepEqual(await readdir(join(dir,'node_game')),['companion.json']);
  assert.equal((await lstat(file)).mode & 0o777,0o600);
}));

test('strict JSON validation rejects malformed fields, missing revisions and client outcomes',async()=>isolated(async({store,dir})=>{
  await serve(store,{},async url=>{
    const invalid=[null,[],{}, {name:''},{name:' '.repeat(3)},{name:'あ'.repeat(17)}, {name:42},
      {name:'a\nb'}, {hair_color:'red'},{hair_color:'#123'}, {clothing_color:'#123456;display:none'},
      {approach:'official'},{risk_percent:0},{risk_percent:101},{risk_percent:36},
      {risk_percent:'35'},{risk_percent:true},{profit_coins:100}];
    for(const patch of invalid) {
      const companion=patch===null || Array.isArray(patch) ? patch : {...c,...patch};
      if(patch && Object.keys(patch).length===0) delete companion.name;
      const r=await post(url,'/api/companion',{expected_revision:0,companion});
      assert.equal(r.status,400,JSON.stringify(patch));
    }
    for(const payload of [{companion:c},{expected_revision:'0',companion:c},{expected_revision:-1,companion:c},
      {expected_revision:0,companion:c,signals:[]}]) {
      assert.equal((await post(url,'/api/companion',payload)).status,400);
    }
    assert.equal((await post(url,'/api/companion',{expected_revision:0,companion:c},
      )).status,200);
  });
}));

test('concurrent saves are serialized across store handles; exactly one revision wins',async()=>isolated(async({store,file})=>{
  const results=await Promise.allSettled([store,createCompanionStore({file}),store].map(s=>
    s.save({expected_revision:0,companion:c})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.status===409));
  assert.equal((await store.read()).revision,1);
}));

test('corrupt records and symlink destination fail without overwriting targets',async()=>isolated(async({store,file,dir})=>{
  await store.save({expected_revision:0,companion:c});
  await writeFile(file,'{}');
  await assert.rejects(store.read(),{status:503});
  await rm(file);const target=join(dir,'untouched');await writeFile(target,'sentinel');
  await symlink(target,file);
  await assert.rejects(store.save({expected_revision:0,companion:c}),{status:503});
  assert.equal(await readFile(target,'utf8'),'sentinel');
}));

test('saved rules reach actual Python and JS accounting; base/owl/turtle remain unchanged',async()=>isolated(async({store})=>{
  let input;
  await serve(store,{predict:async plan=>{input=plan;return pythonPredict(plan);}},async url=>{
    const baseline=await (await post(url,'/api/practice',{allocations})).json();
    let revision=0;
    for(const approach of APPROACHES) {
      await store.save({expected_revision:revision++,companion:{...c,approach}});
      const response=await post(url,'/api/practice',{allocations});assert.equal(response.status,200);
      const got=await response.json();
      assert.equal(got.companion_name,c.name);assert.equal(got.companion_revision,revision);
      assert.equal(got.approach,approach);assert.equal(got.risk_percent,75);
      assert.deepEqual(input.base_model,model);assert.deepEqual(input.models.owl,model);assert.deepEqual(input.models.turtle,model);
      assert.equal(input.models.mine.risk_fraction,.75);
      for(const key of APPROACHES) assert.equal(got.characters.mine.plugin_weights[key],key===approach?100:0);
      const plan=await pythonPredict(input);
      const expected=runSyntheticGame({...plan,allocations});
      assert.deepEqual(got.decisions,expected.decisions);assert.equal(got.final_coins,expected.final_coins);
      assert.equal(got.model_sha256,baseline.model_sha256);
      assert.notEqual(got.characters.mine.effective_sha256,baseline.characters.mine.effective_sha256);
    }
    await store.save({expected_revision:revision++,companion:{...c,approach:'trend'}});
    const before=await store.read();
    const plan=applyCompanion({base_model:model,models:{mine:model,owl:model,turtle:model}},before);
    const high=runSyntheticGame({...await pythonPredict(plan),allocations});
    await store.save({expected_revision:revision++,companion:{...c,approach:'trend',risk_percent:15}});
    const low=await (await post(url,'/api/practice',{allocations})).json();
    assert.notEqual(low.final_coins,high.final_coins,'risk actually changes game accounting');
  });
}));

test('companion revision change during actual prediction returns 409 and no reward ticket',async()=>isolated(async({store})=>{
  await serve(store,{predict:async plan=>{
    const result=await pythonPredict(plan);
    await store.save({expected_revision:0,companion:c});return result;
  }},async url=>{
    const r=await post(url,'/api/practice',{allocations});assert.equal(r.status,409);
    const error=await r.json();assert.match(error.error,/相棒変更/);assert.equal(error.training_ticket,undefined);
  });
}));

test('store default reads never create files; successful save and stale rejection restore atomically',async()=>isolated(async({store,file,dir})=>{
  const initial=await store.read();assert.equal(initial.created,false);assert.equal(initial.revision,0);
  assert.deepEqual(await readdir(dir),[]);
  const saved=await store.save({expected_revision:0,companion:c});
  assert.equal(saved.companion.hair_color,'#abcdef');assert.equal(saved.companion.name,c.name);
  await assert.rejects(store.save({expected_revision:0,companion:{...c,name:'other'}}),{status:409});
  assert.deepEqual(await createCompanionStore({file}).read(),saved);
  assert.deepEqual(await readdir(join(dir,'node_game')),['companion.json']);
}));

test('store validation accepts Unicode boundaries and rejects invalid field types and extra keys',async()=>isolated(async({store,dir})=>{
  assert.equal(validateCompanion({...c,name:'🌸'.repeat(16)}).name,'🌸'.repeat(16));
  for(const patch of [{name:''},{name:'   '},{name:'🌸'.repeat(17)},{name:123},{name:'a\nb'},
    {hair_color:'red'},{hair_color:123},{clothing_color:'#123'},{approach:'unknown'},
    {risk_percent:0},{risk_percent:101},{risk_percent:36},{risk_percent:35.5},{risk_percent:'35'},
    {risk_percent:true},{extra:'ignored?'}]) {
    await assert.rejects(store.save({expected_revision:0,companion:{...c,...patch}}),{status:400});
  }
  for(const payload of [{companion:c},{expected_revision:0},{expected_revision:'0',companion:c},
    {expected_revision:0,companion:c,signals:[]},null,[]]) await assert.rejects(store.save(payload),{status:400});
  assert.deepEqual(await readdir(dir),[]);
}));

test('store companion overlay is immutable and leaves default, base and other slots intact',()=>{
  const input={base_model:model,models:{mine:model,owl:model,turtle:model}};
  assert.equal(applyCompanion(input,{created:false}),input);
  for(const approach of APPROACHES) {
    const overlay=applyCompanion(input,{created:true,companion:{...c,approach}});
    assert.equal(overlay.base_model,model);assert.equal(overlay.models.owl,model);assert.equal(overlay.models.turtle,model);
    assert.equal(overlay.models.mine.risk_fraction,.75);
    assert.equal(overlay.models.mine.plugin_weights[approach],100);
    assert.equal(Object.values(overlay.models.mine.plugin_weights).reduce((a,b)=>a+b),100);
    assert.equal(model.risk_fraction,.35);assert.equal(model.plugin_weights.trend,100);
  }
});

// Handler-level coverage also runs in restricted environments without opening sockets.
async function dispatch(server, path, payload) {
  const data=payload===undefined ? null : JSON.stringify(payload);
  const request=Readable.from(data===null ? [] : [Buffer.from(data)]);
  request.method=data===null?'GET':'POST'; request.url=path;
  request.headers={host:'127.0.0.1:18890',...(data===null?{}:{'content-type':'application/json','content-length':String(Buffer.byteLength(data))})};
  request.socket={remoteAddress:'127.0.0.1'};
  server.address=()=>({port:18890});
  return new Promise((resolve,reject)=>{
    let status;
    const response={writeHead(code){status=code;},end(body){resolve({status,body:JSON.parse(body.toString())});}};
    server.listeners('request')[0](request,response).catch(reject);
  });
}

test('handler APIs preserve default and apply all saved rules through actual Python and JS accounting',async()=>isolated(async({store,dir})=>{
  let submitted;
  const server=createGameServer({companionStore:store,loadSnapshot:async()=>snapshot(),
    predict:async input=>{submitted=input;return pythonPredict(input);}});
  const initial=await dispatch(server,'/api/companion');assert.equal(initial.status,200);
  assert.equal(initial.body.created,false);assert.deepEqual(await readdir(dir),[]);
  const baseline=await dispatch(server,'/api/practice',{allocations});assert.equal(baseline.status,200);
  assert.equal(baseline.body.companion_revision,0);assert.equal(baseline.body.approach,null);
  assert.deepEqual(submitted.models.mine,model);
  let revision=0;
  for(const approach of APPROACHES) {
    const save=await dispatch(server,'/api/companion',{expected_revision:revision++,companion:{...c,approach}});
    assert.equal(save.status,200);
    const result=await dispatch(server,'/api/practice',{allocations});assert.equal(result.status,200);
    assert.equal(result.body.companion_name,c.name);assert.equal(result.body.companion_revision,revision);
    assert.equal(result.body.approach,approach);assert.equal(result.body.risk_percent,75);
    assert.deepEqual(submitted.base_model,model);assert.deepEqual(submitted.models.owl,model);assert.deepEqual(submitted.models.turtle,model);
    assert.equal(submitted.models.mine.risk_fraction,.75);
    for(const key of APPROACHES) assert.equal(result.body.characters.mine.plugin_weights[key],key===approach?100:0);
    const expected=runSyntheticGame({...await pythonPredict(submitted),allocations});
    assert.equal(result.body.final_coins,expected.final_coins);assert.deepEqual(result.body.decisions,expected.decisions);
    assert.equal(result.body.model_sha256,baseline.body.model_sha256);
    if(approach!=='trend')assert.notDeepEqual(result.body.decisions,baseline.body.decisions,'approach changes real signals');
  }
  await dispatch(server,'/api/companion',{expected_revision:revision++,companion:{...c,approach:'trend',risk_percent:75}});
  const high=await dispatch(server,'/api/practice',{allocations});
  await dispatch(server,'/api/companion',{expected_revision:revision++,companion:{...c,approach:'trend',risk_percent:15}});
  const low=await dispatch(server,'/api/practice',{allocations});
  assert.notEqual(high.body.final_coins,low.body.final_coins);
  assert.equal((await dispatch(server,'/api/companion',{expected_revision:0,companion:c})).status,409);
  assert.equal((await dispatch(server,'/api/companion',{companion:c})).status,400);
  assert.equal((await dispatch(server,'/api/practice',{allocations,signals:[]})).status,400);
  assert.equal((await dispatch(server,'/api/practice',{allocations,profit_coins:999999})).status,400);
}));

test('handler rejects companion edits during prediction with 409 and no result or ticket',async()=>isolated(async({store})=>{
  const server=createGameServer({companionStore:store,loadSnapshot:async()=>snapshot(),predict:async input=>{
    const plan=await pythonPredict(input);await store.save({expected_revision:0,companion:c});return plan;
  }});
  const response=await dispatch(server,'/api/practice',{allocations});
  assert.equal(response.status,409);assert.match(response.body.error,/相棒変更/);
  assert.equal(response.body.training_ticket,undefined);assert.equal(response.body.final_coins,undefined);
}));

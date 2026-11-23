import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {analysisCatalog,deriveAccessoryAnalysis,validateAnalysisPolicies} from '../../game_runtime/accessory-analysis.mjs';
import {ACCESSORY_ANALYSIS_API as API,createAccessoryAnalysisStore} from '../../game_runtime/accessory-analysis-store.mjs';
import {createCharacterEquipmentStore} from '../../game_runtime/character-equipment.mjs';
import {createIndependentPartReader} from '../../game_runtime/independent-part-reader.mjs';
import {createGameServer,pythonPredict} from '../../game_runtime/server.mjs';
import {compareLocalAccessoryBatch} from '../../game_runtime/historical-market.mjs';
import {validateLabModel} from '../../game_runtime/model-lab.mjs';

const run=promisify(execFile);
const base={fast_window:4,slow_window:10,risk_fraction:.35,
  plugin_weights:{trend:40,momentum:20,reversion:25,volatility:15},
  plugin_strengths:{trend:110,momentum:90,reversion:105,volatility:100}};
const target={trend:31,momentum:38,reversion:19,volatility:12};
const pin={kind_id:'fixture.pin',focus:'momentum',intensity:3};
const ring={kind_id:'fixture.ring',focus:'volatility',intensity:1};
const entry=(digit,kind_id)=>({part_id:'pt_'+digit.repeat(32),image_sha256:digit.repeat(64),kind_id});
const overlay=({part_id,image_sha256},visible=true)=>({part_id,image_sha256,visible,layer_anchor:'outfit',x:0,y:0});

test('explicit visible-kind policies rebalance weights and preserve all other model parameters',()=>{
  const item=entry('a',pin.kind_id);
  const catalog=analysisCatalog([item]);
  const compare=(rules,parts)=>deriveAccessoryAnalysis(base,rules,parts,catalog);
  assert.equal(compare([], [overlay(item)]).candidate,base);
  assert.equal(compare([pin], []).candidate,base);
  assert.equal(compare([pin], [overlay(item,false)]).candidate,base);
  assert.deepEqual(compare([pin],[overlay(item)]),{
    candidate:{...base,plugin_weights:target},applied:[pin],visibleKinds:[pin.kind_id]});
  assert.deepEqual(compare([{kind_id:pin.kind_id,focus:pin.focus}],[overlay(item)]).candidate.plugin_weights,
    {trend:36,momentum:27,reversion:23,volatility:14});
  assert.deepEqual(base.plugin_weights,{trend:40,momentum:20,reversion:25,volatility:15});
});

test('multiple kinds combine deterministically with a single contribution per kind',()=>{
  const first=entry('a',pin.kind_id), second=entry('b',pin.kind_id), third=entry('c',ring.kind_id);
  const equipped=[first,second,third,first].map(item=>overlay(item));
  const catalog=analysisCatalog([third,second,first]);
  assert.deepEqual(catalog.kinds,[{kind_id:pin.kind_id,part_count:2},{kind_id:ring.kind_id,part_count:1}]);
  const result=deriveAccessoryAnalysis(base,[pin,ring],equipped,catalog);
  assert.deepEqual(result,deriveAccessoryAnalysis(base,[ring,pin],[...equipped].reverse(),catalog));
  assert.deepEqual(result.candidate.plugin_weights,{trend:28,momentum:36,volatility:18,reversion:18});
  assert.equal(Object.values(result.candidate.plugin_weights).reduce((a,b)=>a+b),100);
});

test('strict rule validation and stale, missing, or tampered equipment fail closed',()=>{
  const item=entry('a',pin.kind_id);
  const catalog=analysisCatalog([item]);
  for(const rule of [{...pin,extra:true},{...pin,kind_id:'glasses'},{...pin,kind_id:'a.b\n'},
    {...pin,focus:'unknown'},...[0,4,1.5,true,'2',null].map(intensity=>({...pin,intensity}))]) {
    assert.throws(()=>validateAnalysisPolicies([rule]),{status:400});
  }
  assert.throws(()=>validateAnalysisPolicies([pin,pin]),{status:400});
  assert.throws(()=>validateAnalysisPolicies(Array.from({length:33},(_,i)=>({...pin,kind_id:'fixture.rule'+i}))),{status:400});
  assert.throws(()=>analysisCatalog([item,item]),{status:503});
  assert.throws(()=>deriveAccessoryAnalysis(base,[ring],[],catalog),{status:422});
  assert.throws(()=>deriveAccessoryAnalysis(base,[],[overlay(entry('b',pin.kind_id),false)],catalog),{status:422});
  assert.throws(()=>deriveAccessoryAnalysis(base,[],[{...overlay(item,false),image_sha256:'b'.repeat(64)}],catalog),{status:422});
  assert.throws(()=>deriveAccessoryAnalysis(base,[pin],[overlay(item),overlay(item,false)],catalog),{status:422});
});

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'creature-analysis-http-'));
  const mcp=join(root,'mcp'), local=join(root,'local_state');
  const servers=[];
  t.after(async()=>{
    await Promise.all(servers.map(server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})));
    await rm(root,{recursive:true,force:true});
  });
  await mkdir(mcp);
  for(const name of ['accessory_analysis_store.py','character_equipment.py','character_parts.py',
    'independent_parts.py','independent_parts_catalog.py','import_png_character.py']) {
    await copyFile(new URL('../'+name,import.meta.url),join(mcp,name));
  }
  const {stdout}=await run('python3',['-B','-E','-c',`
import base64, io, json, os, sys
from pathlib import Path
from PIL import Image, ImageDraw
sys.path.insert(0, 'mcp')
from import_png_character import register
from independent_parts import prepare_catalog_part, sha256
os.umask(0o077)
def encode(im):
    out = io.BytesIO()
    im.save(out, format='PNG')
    return out.getvalue()
atlas = Image.new('RGBA', (1152, 208))
ImageDraw.Draw(atlas).rectangle((20, 30, 26, 40), fill='blue')
encoded = base64.b64encode(encode(atlas)).decode()
cp = register({'name': 'S99 fixture', 'parts': dict.fromkeys(('body','ready','happy','cautious'), encoded)})['generated_id']
cell = encode(atlas.crop((0, 0, 192, 208)))
candidate = {'schema_version':1, 'candidate_id':'sg_'+'a'*32,'source_id':cp,
    'source_sha256':sha256(encode(atlas)),'part_png_sha256':sha256(cell),'not_registered_in_game':True,
    'metadata':{'source_part':'ready','frame':0,'review_required':True,'width':192,'height':208,'bbox':[20,30,27,41]}}
manifest,png = prepare_catalog_part(candidate,cell,kind_id='fixture.pin',layer_anchor='outfit',
    rights={'basis':'original','holder':'Fixture','reference':''})
target = Path('local_state/independent_parts') / manifest['part_id']
target.mkdir(parents=True)
(target/'manifest.json').write_text(json.dumps(manifest))
(target/'part.png').write_bytes(png)
print(json.dumps({'cp':cp,'part':{'part_id':manifest['part_id'],'image_sha256':manifest['image']['sha256'],
      'layer_anchor':'outfit','visible':True,'x':0,'y':0}}))
`],{cwd:root,timeout:5000,maxBuffer:4096});
  const {cp,part}=JSON.parse(stdout);
  const python=await run('python3',['-B','-E','-c',`
import json,sys
from engine import Model,PLUGIN_IDS,view
raw=json.loads(sys.argv[1])
model=Model(raw['fast_window'],raw['slow_window'],raw['risk_fraction'],
            tuple(raw['plugin_weights'][k] for k in PLUGIN_IDS),
            tuple(raw['plugin_strengths'][k] for k in PLUGIN_IDS))
print(json.dumps(view(model,7)))
`,JSON.stringify(base)],{cwd:new URL('../../',import.meta.url),timeout:5000,maxBuffer:65536});
  const state=JSON.parse(python.stdout);
  const snapshot={state,lineup:{slots:['owl','turtle'].map(slot=>({slot,model:state.model}))},
    source_revision:7,lineup_revision:1,growth_revision:0};
  const baselineSnapshot=JSON.stringify(snapshot);
  const equipment=createCharacterEquipmentStore({script:join(mcp,'character_equipment.py')});
  await equipment.save(cp,{expected_revision:0,parts:[part]});
  const reader=createIndependentPartReader({script:join(mcp,'independent_parts_catalog.py')});
  const analysisStore=createAccessoryAnalysisStore({script:join(mcp,'accessory_analysis_store.py')});
  const calls=[];
  const active={active_demo_id:cp,revision:3};
  const companion={created:false,revision:0};
  const start=async(overrides={})=>{
    const server=createGameServer({
      catalogRoot:join(local,'character_parts'),equipmentStore:equipment,
      accessoryAnalysisStore:analysisStore,
      independentPartReader:{list:reader.list,image(){throw Error('Comparison must not serve an image');}},
      activeCharacterStore:{read:()=>({...active}),save(){throw Error('Unexpected write');}},
      companionStore:{read:()=>({...companion}),save(){throw Error('Unexpected write');}},
      store:{public(){throw Error('Use the fixture snapshot');},complete(){throw Error('Unexpected XP write');}},
      loadSnapshot:async()=>snapshot,
      predict:async plan=>{calls.push(structuredClone(plan));return pythonPredict(plan);},...overrides,
    });
    await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
    servers.push(server);
    const origin='http://127.0.0.1:'+server.address().port;
    return {origin,get:(path=API,options)=>fetch(origin+path,options),post:(input,path=API,headers={})=>
      fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...headers},body:JSON.stringify(input)})};
  };
  return {start,cp,part,local,calls,active,companion,snapshot,baselineSnapshot,equipment};
}
const compareInput=info=>({character_id:info.equipped.character_id,active_revision:info.equipped.active_revision,
  equipment_revision:info.equipped.equipment_revision,expected_revision:info.revision});

test('HTML and its exact module URL are served and /game links from the appearance studio',async t=>{
  const {start}=await fixture(t);
  const api=await start();
  const page=await api.get('/accessory-analysis.html');
  assert.equal(page.status,200);
  assert.match(page.headers.get('content-type'),/^text\/html/);
  assert.match(page.headers.get('content-security-policy'),/connect-src 'self'/);
  const html=await page.text();
  const script=html.match(/<script type="module" src="([^"]+)"/)?.[1];
  assert.equal(script,'/accessory-analysis-ui.mjs');
  const js=await api.get(script);
  assert.equal(js.status,200);
  assert.match(js.headers.get('content-type'),/^text\/javascript/);
  assert.equal(js.headers.get('x-content-type-options'),'nosniff');
  assert.match(await js.text(),/\/api\/accessory-analysis\/v1/);
  assert.equal((await api.get('/accessory-analysis.mjs')).status,404);
  assert.equal((await api.get(script+'?x=1')).status,404);
  assert.equal((await api.get('/accessory-analysis.html',{headers:{Origin:'https://outside.invalid'}})).status,403);
  assert.match(await api.get('/game').then(r=>r.text()),/href="\/accessory-analysis\.html"/);
});

test('explicit save and actual Python comparison change weights/hash while making no other writes',async t=>{
  const {start,cp,part,local,calls,snapshot,baselineSnapshot}=await fixture(t);
  const api=await start();
  const folder=join(local,'accessory_analysis');
  const equipmentPath=join(local,'character_equipment',cp+'.json');
  const image=join(local,'independent_parts',part.part_id,'part.png');
  const initialFiles=await Promise.all([readFile(equipmentPath),readFile(image)]);
  assert.deepEqual(validateLabModel(snapshot.state.model),base);
  const metadata=await api.get();
  assert.equal(metadata.headers.get('cache-control'),'no-store');
  assert.equal(metadata.headers.get('access-control-allow-origin'),null);
  const initial=await metadata.json();
  assert.deepEqual(initial,{schema:1,revision:0,policies:[],kinds:[{kind_id:pin.kind_id,part_count:1}],
    equipped:{character_id:cp,active_revision:3,equipment_revision:1,visible_kinds:[pin.kind_id]},stale_kinds:[]});
  assert.equal(calls.length,0);
  await assert.rejects(readdir(folder),{code:'ENOENT'});
  const unchanged=await api.post(compareInput(initial),API+'/compare').then(r=>r.json());
  assert.equal(unchanged.weights_changed,false);
  assert.equal(unchanged.effective_hash_changed,false);
  assert.equal(unchanged.difference.different_signals,0);
  await assert.rejects(readdir(folder),{code:'ENOENT'});
  const saved=await api.post({expected_revision:0,policies:[pin]});
  assert.equal(saved.status,200);
  assert.deepEqual(await saved.json(),{schema:1,revision:1,policies:[pin]});
  const file=join(folder,'analysis.json');
  assert.equal((await stat(file)).mode&0o777,0o600);
  const ruleBytes=await readFile(file);
  const compare=await api.post({...compareInput(initial),expected_revision:1},API+'/compare');
  assert.equal(compare.status,200);
  const report=await compare.json();
  assert.equal(calls.length,2);
  assert.deepEqual(calls[1],{base_model:base,models:{mine:{...base,plugin_weights:target},owl:base,turtle:base}});
  assert.deepEqual(report.baseline.parameters,base);
  assert.deepEqual(report.candidate.parameters,{...base,plugin_weights:target});
  assert.equal(report.weights_changed,true);
  assert.equal(report.effective_hash_changed,true);
  assert.notEqual(report.baseline.effective_sha256,report.candidate.effective_sha256);
  assert.match(report.candidate.effective_sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(report.provenance.applied_rules,[pin]);
  assert.equal(report.scope,'ACCESSORY_RULES_FIXED_SYNTHETIC_12');
  for(const flag of ['trained','live_market','holdout_evaluated','save_performed','xp_awarded'])assert.equal(report[flag],false);
  assert.equal(report.baseline.signals.length,12);
  assert.equal(report.candidate.signals.length,12);
  for(const variant of [report.baseline,report.candidate]) {
    assert.ok(Number.isFinite(variant.return_pct));
    assert.ok(variant.max_drawdown_pct>=0 && variant.max_drawdown_pct<=100);
    assert.ok(Math.abs(variant.return_pct-variant.profit_coins/100)<.001);
  }
  assert.equal(report.difference.different_signals,report.baseline.signals.filter((signal,i)=>signal!==report.candidate.signals[i]).length);
  assert.equal(report.difference.different_signals,1);
  t.diagnostic('Python bridge: '+JSON.stringify({baseline:base.plugin_weights,candidate:target,
    different_signals:report.difference.different_signals,profit_delta:report.difference.profit_coins,
    baseline_return:report.baseline.return_pct,candidate_return:report.candidate.return_pct,
    baseline_drawdown:report.baseline.max_drawdown_pct,candidate_drawdown:report.candidate.max_drawdown_pct}));
  assert.deepEqual(await readFile(file),ruleBytes);
  assert.deepEqual(await Promise.all([readFile(equipmentPath),readFile(image)]),initialFiles);
  assert.equal(JSON.stringify(snapshot),baselineSnapshot);
  assert.deepEqual((await readdir(local)).sort(),['accessory_analysis','character_equipment','character_parts','independent_parts']);
});

test('accessory HTTP requires same origin and strict revisions, catalog and equipment validation',async t=>{
  const {start,cp,part,local,calls,active,equipment}=await fixture(t);
  const api=await start(), other=await start();
  const body={expected_revision:0,policies:[pin]};
  const record=await api.get().then(r=>r.json());
  const compare=compareInput(record);
  for(const [headers,status] of [[{Origin:'https://outside.invalid'},403],
    [{Origin:api.origin.replace('127.0.0.1','localhost')},403],
    [{'Sec-Fetch-Site':'cross-site'},403],[{'Content-Type':'text/plain'},415]]) {
    assert.equal((await api.post(body,API,headers)).status,status);
    assert.equal((await api.post(compare,API+'/compare',headers)).status,status);
  }
  const wrongHost=await new Promise((resolve,reject)=>{
    const req=request(api.origin+API,{headers:{Host:'outside.invalid'}},res=>{res.resume();resolve(res.statusCode);});
    req.once('error',reject);req.end();
  });
  assert.equal(wrongHost,403);
  assert.equal((await fetch(api.origin+API,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await api.get(API+'/compare')).status,404);
  assert.equal((await api.get(API+'?kind=foo')).status,404);
  assert.equal((await api.get(API,{method:'OPTIONS'})).status,404);
  for(const bad of [null,{...body,unexpected:true},{...body,expected_revision:false},{...body,policies:[pin,pin]}]) {
    assert.equal((await api.post(bad)).status,400);
  }
  assert.equal((await api.post({...body,padding:'x'.repeat(8192)})).status,413);
  assert.equal((await api.post({...body,policies:[ring]})).status,422);
  assert.equal((await api.post({...compare,character_id:'cp_bad'},API+'/compare')).status,400);
  assert.equal((await api.post({...compare,candidate:base},API+'/compare')).status,400);
  assert.equal((await api.post({...compare,expected_revision:1},API+'/compare')).status,409);
  assert.equal(calls.length,0);
  assert.deepEqual((await Promise.all([api.post(body),other.post(body)])).map(res=>res.status).sort(),[200,409]);
  assert.equal((await api.post(compare,API+'/compare')).status,409);
  const current={...compare,expected_revision:1};
  active.revision++;
  assert.equal((await api.post(current,API+'/compare')).status,409);
  active.revision--;
  const folder=join(local,'independent_parts',part.part_id);
  const png=join(folder,'part.png');
  await writeFile(png,'broken synthetic fixture');
  assert.equal((await api.get()).status,503);
  assert.equal((await api.post(current,API+'/compare')).status,503);
  await rm(folder,{recursive:true});
  assert.equal((await api.get()).status,422);
  await equipment.save(cp,{expected_revision:1,parts:[]});
  const stale=await api.get().then(r=>r.json());
  assert.deepEqual(stale.stale_kinds,[pin.kind_id]);
  assert.equal((await api.post(compareInput(stale),API+'/compare')).status,422);
  assert.equal((await api.post({expected_revision:1,policies:[]})).status,200);
  assert.equal(calls.length,0);
});

const QUICK='/api/quick-practice';
const practiceInput={amount:1800,leverage:3,model_id:'self',scenario_token:'v1_0000000000000005'};
async function practiceContext(api,policies=[pin]) {
  const saved=await api.post({expected_revision:0,policies});
  assert.equal(saved.status,200);
  return compareInput(await api.get().then(response=>response.json()));
}

test('quick practice applies only the selected rule to one real Python run on the same scenario',async t=>{
  const {start,cp,part,local,calls,snapshot,baselineSnapshot}=await fixture(t);
  const api=await start();
  const context=await practiceContext(api);
  const files=[
    join(local,'accessory_analysis','analysis.json'),
    join(local,'character_equipment',cp+'.json'),
    join(local,'independent_parts',part.part_id,'part.png'),
  ];
  const before=await Promise.all(files.map(path=>readFile(path)));
  const response=await api.post(practiceInput,QUICK);
  assert.equal(response.status,200);
  const baselineBody=await response.text();
  const regular=JSON.parse(baselineBody);
  assert.equal(Object.hasOwn(regular,'accessory_analysis'),false);

  const chosen=await api.post({...practiceInput,accessory_analysis:context},QUICK);
  const value=await chosen.json();
  assert.equal(chosen.status,200,JSON.stringify(value));
  assert.equal(calls.length,2,'one Python call per practice');
  assert.deepEqual(calls[0].models.mine,base);
  assert.deepEqual(calls[1],{...calls[0],models:{...calls[0].models,mine:{...base,plugin_weights:target}}});
  assert.deepEqual(value.daily_synthetic_prices,regular.daily_synthetic_prices);
  for(const field of ['scenario_token','scenario_kind','invested_coins','leverage','real_market','persisted','order_placed','xp_awarded'])
    assert.equal(value[field],regular[field]);
  assert.deepEqual(value.daily_ai_signals.flatMap((signal,i)=>signal===regular.daily_ai_signals[i]?[]:[i+1]),[2]);
  const summary=value.accessory_analysis;
  assert.deepEqual(summary,{
    source:'saved_accessory_analysis',character_id:cp,policy_revision:1,applied_rules:[pin],
    baseline_weights:base.plugin_weights,candidate_weights:target,
    baseline_sha256:'45b6170419160970da384cc178498cc56264b3dfbca3583da69805bf3f335067',
    candidate_sha256:'c66f30330a67480575e143c2c946255a491a605cc64df8e62cfdba49ad7eca45',
    weights_changed:true,effective_hash_changed:true,trained:false,real_market:false,persisted:false,
  });
  const defaultOnly=await start({
    independentPartReader:{list(){assert.fail('Default practice must not read the catalog');}},
    accessoryAnalysisStore:{read(){assert.fail('Default practice must not read policy');}},
    equipmentStore:{read(){assert.fail('Default practice must not read equipment');}},
    activeCharacterStore:{read(){assert.fail('Default practice must not read the character');}},
  });
  const noOrigin=await fetch(defaultOnly.origin+QUICK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(practiceInput)});
  assert.equal(noOrigin.status,200);
  assert.equal(await noOrigin.text(),baselineBody,'ordinary response and legacy origin behavior remain exact');
  assert.deepEqual(await Promise.all(files.map(path=>readFile(path))),before);
  assert.equal(JSON.stringify(snapshot),baselineSnapshot);
  assert.deepEqual((await readdir(local)).sort(),['accessory_analysis','character_equipment','character_parts','independent_parts']);
  t.diagnostic('Real Python on a fixed replay token: day 2 '+regular.daily_ai_signals[1]+' → '+value.daily_ai_signals[1]);
});

test('opt-in refuses forged origins, arbitrary models, unapplied rules, stale revisions and invalid equipment',async t=>{
  const {start,cp,part,local,calls,equipment}=await fixture(t);
  const api=await start();
  const context=compareInput(await api.get().then(response=>response.json()));
  const send=(accessory_analysis,overrides={},headers={})=>api.post({...practiceInput,accessory_analysis,...overrides},QUICK,headers);
  const noOrigin=await fetch(api.origin+QUICK,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({...practiceInput,accessory_analysis:context})});
  assert.equal(noOrigin.status,403);
  for(const headers of [{Origin:'https://outside.invalid'},{Origin:api.origin.replace('127.0.0.1','localhost')},{'Sec-Fetch-Site':'cross-site'}])
    assert.equal((await send(context,{},headers)).status,403);
  for(const bad of [null,{},[context],{...context,weights:base.plugin_weights},{...context,active_revision:4.5},
    {...context,expected_revision:false},{...context,equipment_revision:-1},{...context,character_id:'../file'}]) {
    assert.equal((await send(bad)).status,400);
  }
  assert.equal((await send(context,{model_id:'demo_trend'})).status,400);
  assert.equal((await send(context,{'leverage|scenario_token':'extra'})).status,400);
  assert.equal((await send(context)).status,422,'empty saved rules must not fall back to baseline');
  const saved=await practiceContext(api);
  for(const mismatched of [{character_id:'cp_'+'f'.repeat(32)},{active_revision:0},{expected_revision:0},{equipment_revision:0}])
    assert.equal((await send({...saved,...mismatched})).status,409);
  await equipment.save(cp,{expected_revision:1,parts:[{...part,visible:false}]});
  assert.equal((await send({...saved,equipment_revision:2})).status,422);
  await equipment.save(cp,{expected_revision:2,parts:[{...part,image_sha256:'0'.repeat(64)}]});
  assert.equal((await send({...saved,equipment_revision:3})).status,422);
  await equipment.save(cp,{expected_revision:3,parts:[]});
  await rm(join(local,'independent_parts',part.part_id),{recursive:true});
  assert.equal((await send({...saved,equipment_revision:4})).status,422);
  assert.equal(calls.length,0);
});

test('opt-in discards a computed run if the active character, records or model change during prediction',async t=>{
  const {start,cp,part,active,companion,snapshot,equipment}=await fixture(t);
  const setup=await start();
  let context=await practiceContext(setup);
  let during=()=>{};
  let calls=0;
  const api=await start({predict:async plan=>{
    calls++;
    const result=await pythonPredict(plan);
    await during();
    return result;
  }});
  const run=()=>api.post({...practiceInput,accessory_analysis:context},QUICK);
  during=()=>{active.active_demo_id='cp_'+'b'.repeat(32);active.revision++;};
  assert.equal((await run()).status,409);
  active.active_demo_id=cp;
  active.revision++;
  context={...context,active_revision:active.revision};
  during=()=>equipment.save(cp,{expected_revision:1,parts:[{...part,x:1}]});
  assert.equal((await run()).status,409);
  context.equipment_revision++;
  during=async()=>assert.equal((await setup.post({expected_revision:1,policies:[{...pin,intensity:2}]})).status,200);
  assert.equal((await run()).status,409);
  context.expected_revision++;
  // Inject a fresh snapshot per read, as in the production loader.
  const modelApi=await start({
    loadSnapshot:async()=>({...snapshot}),
    predict:async plan=>{calls++;const result=await pythonPredict(plan);await during();return result;},
  });
  during=()=>{snapshot.source_revision++;};
  assert.equal((await modelApi.post({...practiceInput,accessory_analysis:context},QUICK)).status,409);
  during=()=>{companion.revision++;};
  assert.equal((await run()).status,409);
  assert.equal(calls,5);
});

test('valid rules with identical effective weights report the unchanged model honestly',async t=>{
  const {start,companion,calls}=await fixture(t);
  Object.assign(companion,{created:true,revision:1,companion:{name:'Fixture',approach:'momentum',risk_percent:35}});
  const api=await start();
  const context=await practiceContext(api);
  const response=await api.post({...practiceInput,accessory_analysis:context},QUICK);
  const body=await response.json();
  assert.equal(response.status,200,JSON.stringify(body));
  assert.equal(body.accessory_analysis.weights_changed,false);
  assert.equal(body.accessory_analysis.effective_hash_changed,false);
  assert.equal(body.accessory_analysis.baseline_sha256,body.accessory_analysis.candidate_sha256);
  assert.deepEqual(calls[0].base_model,calls[0].models.mine,'hash baseline must include the saved companion');
  assert.deepEqual(body.accessory_analysis.applied_rules,[pin]);
});

const HISTORY=API+'/historical';
const windowA='mkt_'+'a'.repeat(24);
const windowB='mkt_'+'b'.repeat(24);

async function historicalFixture({selection,...models}) {
  const plan=await pythonPredict(models);
  return {
    mode:'HISTORICAL_MARKET_REPLAY_ONLY',source_origin:'LOCAL_JPX_REPORT_CACHE_2024',
    source:'Fixture JPX 2024',source_warning:'Fixture unadjusted data',
    adjusted:false,market_id:selection.replay_id ?? (selection.exclude_id===windowA?windowB:windowA),code:'40050',
    start_date:'2024-01-04',history_end_date:'2024-02-08',end_date:'2024-02-26',
    lookback_days:24,future_days:12,eligible_windows:694,price_index_base:100,flat_threshold_pct:.3,
    brier:{mine:.63,owl:.71,turtle:.71},plan,
  };
}

test('accessory history uses only the explicit local source, returns aggregates, and does not persist results',async t=>{
  const {start,cp,part,local,snapshot,baselineSnapshot,calls}=await fixture(t);
  const history=[];
  const api=await start({historicalPredict:async (input,options)=>{
    history.push({input,options});
    return historicalFixture(input);
  }});
  const context=await practiceContext(api);
  const paths=[join(local,'accessory_analysis','analysis.json'),
    join(local,'character_equipment',cp+'.json'),join(local,'independent_parts',part.part_id,'part.png')];
  const before=await Promise.all(paths.map(path=>readFile(path)));
  for(const [selection,id] of [[{},windowA],[{replay_id:windowB},windowB],[{exclude_id:windowA},windowB]]) {
    const response=await api.post({...context,...selection},HISTORY);
    const result=await response.json();
    assert.equal(response.status,200,JSON.stringify(result));
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'),null);
    assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');
    assert.equal(result.scope,'ACCESSORY_RULES_HISTORICAL_LOCAL_12');
    assert.equal(result.mode,'HISTORICAL_MARKET_REPLAY_ONLY');
    assert.deepEqual(result.market,{id,code:'40050',period_start:'2024-01-04',history_end:'2024-02-08',
      period_end:'2024-02-26',source_origin:'LOCAL_JPX_REPORT_CACHE_2024',source:'Fixture JPX 2024',
      warning:'Fixture unadjusted data',adjusted:false,eligible_windows:694,lookback_days:24,
      simulation_days:12,flat_threshold_pct:.3});
    assert.deepEqual(result.provenance,{character_id:cp,active_revision:context.active_revision,
      equipment_revision:context.equipment_revision,policy_revision:context.expected_revision,
      visible_kinds:[pin.kind_id],applied_rules:[pin]});
    assert.equal(result.read_only,true);
    assert.equal(result.real_market_history,true);
    assert.equal(result.weights_changed,true);
    assert.equal(result.effective_hash_changed,true);
    assert.equal(result.difference.different_signals,1);
    assert.match(result.notice,/互いに重なる/);
    for(const flag of ['trained','live_market','holdout_evaluated','persisted','save_performed','xp_awarded','coins_changed','order_placed'])
      assert.equal(result[flag],false);
    assert.equal(result.baseline.brier,.71);
    assert.equal(result.candidate.brier,.63);
    assert.deepEqual(result.candidate.parameters.plugin_weights,target);
    for(const summary of [result.baseline,result.candidate]) {
      assert.ok(Number.isFinite(summary.profit_coins));
      assert.ok(Number.isFinite(summary.max_drawdown_pct));
      for(const field of ['signals','equity_path'])assert.equal(Object.hasOwn(summary,field),false);
    }
    for(const field of ['training_ticket','plan','future_prices','history','part_png'])
      assert.equal(Object.hasOwn(result,field),false);
    assert.deepEqual(history.at(-1),{input:{base_model:base,
      models:{mine:{...base,plugin_weights:target},owl:base,turtle:base},selection},options:{source:'local'}});
  }
  assert.equal(calls.length,0,'never uses the synthetic comparison route');
  assert.deepEqual(await Promise.all(paths.map(path=>readFile(path))),before);
  assert.equal(JSON.stringify(snapshot),baselineSnapshot);
  assert.deepEqual((await readdir(local)).sort(),['accessory_analysis','character_equipment','character_parts','independent_parts']);
});

test('accessory history rejects malformed and forged requests before reading model or invoking history',async t=>{
  const {start,snapshot,cp,part,equipment,local}=await fixture(t);
  let modelReads=0,historyCalls=0;
  const api=await start({
    loadSnapshot:async()=>{modelReads++;return snapshot;},
    historicalPredict:async()=>{historyCalls++;assert.fail('Must never access history');},
  });
  const initial=compareInput(await api.get().then(response=>response.json()));
  const send=(input=initial,headers={})=>api.post(input,HISTORY,headers);
  for(const headers of [{Origin:'https://outside.invalid'},{Origin:api.origin.replace('127.0.0.1','localhost')},{'Sec-Fetch-Site':'cross-site'}])
    assert.equal((await send(initial,headers)).status,403);
  const noOrigin=await fetch(api.origin+HISTORY,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(initial)});
  assert.equal(noOrigin.status,403);
  const wrongHost=await new Promise((resolve,reject)=>{
    const outbound=request(api.origin+HISTORY,{method:'POST',headers:{Host:'outside.invalid',Origin:api.origin}},res=>{
      res.resume();resolve(res.statusCode);
    });
    outbound.once('error',reject);
    outbound.end();
  });
  assert.equal(wrongHost,403);
  assert.equal((await api.get(HISTORY)).status,404);
  assert.equal((await api.post(initial,HISTORY+'?source=local')).status,404);
  assert.equal((await send(initial,{'Content-Type':'text/plain'})).status,415);
  for(const bad of [null,[initial],{}, {...initial,expected_revision:true},{...initial,character_id:'bad'},
    {...initial,source:'jquants'},{...initial,candidate:{...base}}, {...initial,history_path:'/tmp/data'},
    {...initial,replay_id:windowA,exclude_id:windowB},{...initial,replay_id:windowA+'\n'},
    {...initial,exclude_id:'mkt_'+'A'.repeat(24)},{...initial,replay_id:null},{...initial,exclude_id:42}]) {
    assert.equal((await send(bad)).status,400);
  }
  assert.equal(modelReads,0);
  assert.equal((await send()).status,422);
  const prepared=await practiceContext(api);
  for(const mismatch of [{active_revision:0},{equipment_revision:0},{expected_revision:0},{character_id:'cp_'+'b'.repeat(32)}])
    assert.equal((await send({...prepared,...mismatch})).status,409);
  await equipment.save(cp,{expected_revision:1,parts:[{...part,visible:false}]});
  assert.equal((await send({...prepared,equipment_revision:2})).status,422);
  await equipment.save(cp,{expected_revision:2,parts:[{...part,image_sha256:'0'.repeat(64)}]});
  assert.equal((await send({...prepared,equipment_revision:3})).status,422);
  await equipment.save(cp,{expected_revision:3,parts:[]});
  await rm(join(local,'independent_parts',part.part_id),{recursive:true});
  assert.equal((await send({...prepared,equipment_revision:4})).status,422);
  assert.equal(historyCalls,0);
});

test('historical route discards a result when character, equipment, policy, model or companion changes during computation',async t=>{
  const {start,cp,part,active,companion,equipment,snapshot}=await fixture(t);
  const setup=await start();
  const expected=await practiceContext(setup);
  let mutate;
  const api=await start({
    loadSnapshot:async()=>({...snapshot}),
    historicalPredict:async input=>{
      const result=await historicalFixture(input);
      await mutate();
      return result;
    },
  });
  for(const change of [
    ()=>{active.active_demo_id='cp_'+'b'.repeat(32);active.revision++;},
    ()=>equipment.save(cp,{expected_revision:1,parts:[{...part,x:1}]}),
    async()=>assert.equal((await setup.post({expected_revision:1,policies:[{...pin,intensity:2}]})).status,200),
    ()=>{snapshot.source_revision++;},
    ()=>{companion.revision++;},
  ]) {
    mutate=change;
    const response=await api.post(expected,HISTORY);
    assert.equal(response.status,409,await response.text());
    active.active_demo_id=cp;
    Object.assign(expected,compareInput(await setup.get().then(response=>response.json())));
  }
});

test('historical route fails closed if local data is unavailable, provenance is wrong or selection differs',async t=>{
  const {start}=await fixture(t);
  let change;
  const api=await start({historicalPredict:async input=>change(await historicalFixture(input))});
  const context=await practiceContext(api);
  change=()=>{throw Error('fixture: secret internal path');};
  const unavailable=await api.post(context,HISTORY);
  assert.equal(unavailable.status,503);
  assert.match((await unavailable.json()).error,/ローカルの2024年株価データを読み込めない/);
  for(const update of [{source_origin:'JQUANTS_API_V2_CACHE'},{adjusted:true},{start_date:'2023-12-29'},{market_id:windowB}]) {
    change=value=>({...value,...update});
    const malformed=await api.post({...context,replay_id:windowA},HISTORY);
    assert.equal(malformed.status,503);
    assert.ok(!Object.hasOwn(await malformed.json(),'market'));
  }
  change=value=>({...value,market_id:windowA});
  assert.equal((await api.post({...context,exclude_id:windowA},HISTORY)).status,503);
});

test('historical child process forces local mode and drops inherited credentials before using Python',async t=>{
  const root=await mkdtemp(join(tmpdir(),'creature-history-child-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const prices=join(root,'prehistory.json');
  await writeFile(prices,JSON.stringify({source:'SoftHompo JPX daily reports CSV',series:{
    40050:Array.from({length:42},(_,i)=>({Code:'40050',Date:new Date(Date.UTC(2024,0,i+4)).toISOString().slice(0,10),
      C:100+i*.3+Math.sin(i*.7)*2})),
  }}));
  const before=await readFile(prices);
  const {stdout:interpreter}=await run('python3',['-B','-E','-c','import sys; print(sys.executable)']);
  const python="'"+interpreter.trim().replaceAll("'","'\"'\"'")+"'";
  // The guard refuses to launch Python if any regression could access the network.
  await writeFile(join(root,'python3'),`#!/bin/sh
[ "$CREATURE_MARKET_SOURCE" = "local" ] || exit 71
[ -z "${'${CREATURE_JQUANTS_API_KEY+x}'}" ] && [ -z "${'${HTTPS_PROXY+x}'}" ] && [ -z "${'${PYTHONPATH+x}'}" ] || exit 72
exec ${python} "$@"
`,{mode:0o700});
  const input={base_model:base,models:{mine:{...base,plugin_weights:target},owl:base,turtle:base},selection:{}};
  const entry=new URL('../../game_runtime/server.mjs',import.meta.url);
  const {stdout}=await run(process.execPath,['--input-type=module','-e',`
import {pythonHistoricalPredict,pythonMarketBatchPredict} from ${JSON.stringify(entry.href)};
const {selection,...batchInput}=JSON.parse(process.argv[1]);
const result=await pythonHistoricalPredict({...batchInput,selection},{source:'local'});
const batch=await pythonMarketBatchPredict(batchInput);
console.log(JSON.stringify({result,batch}));
`,JSON.stringify(input)],{env:{PATH:root+':'+process.env.PATH,CREATURE_MARKET_HISTORY_PATH:prices,
    CREATURE_MARKET_SOURCE:'jquants',CREATURE_JQUANTS_API_KEY:'fixture-key',HTTPS_PROXY:'fixture-proxy',PYTHONPATH:'fixture-python-path'},
    timeout:18000,maxBuffer:65536});
  const {result,batch}=JSON.parse(stdout);
  assert.equal(result.source_origin,'LOCAL_JPX_REPORT_CACHE_2024');
  assert.equal(result.adjusted,false);
  assert.equal(result.eligible_windows,7);
  assert.ok(Number.isFinite(result.brier.mine) && Number.isFinite(result.brier.owl));
  assert.notEqual(result.plan.models.mine.effective_sha256,result.plan.models.owl.effective_sha256);
  assert.equal(batch.eligible_windows,7);
  assert.equal(batch.selected_windows,1);
  assert.equal(batch.windows[0].start_date,'2024-01-04');
  assert.equal(batch.windows[0].source_origin,'LOCAL_JPX_REPORT_CACHE_2024');
  assert.deepEqual(await readFile(prices),before);
  assert.deepEqual((await readdir(root)).sort(),['prehistory.json','python3']);
});

const BATCH_HISTORY=API+'/batch-history';
const batchModels={base_model:base,models:{mine:{...base,plugin_weights:target},owl:base,turtle:base}};

async function batchFixture() {
  const first=await historicalFixture({...batchModels,selection:{replay_id:windowA}});
  const rows=[
    [windowA,'40050','2024-01-01','2024-01-24','2024-02-05',110,.6,.5,true],
    [windowB,'40050','2024-02-06','2024-03-01','2024-03-13',90,.8,.9,true],
    ['mkt_'+'c'.repeat(24),'46890','2024-01-01','2024-01-24','2024-02-05',103,.7,.7,false],
  ];
  return {schema:1,eligible_windows:694,selected_windows:rows.length,
    windows:rows.map(([market_id,code,start_date,history_end_date,end_date,price,before,after,trade])=>({
      ...first,market_id,code,start_date,history_end_date,end_date,
      source:'SoftHompo-reformatted JPX daily reports (2024)',
      brier:{owl:before,turtle:before,mine:after},
      plan:{...first.plan,models:structuredClone(first.plan.models),initial_price:100,future_prices:Array(12).fill(price),
        signals:Array.from({length:12},(_,day)=>({owl:'CASH',turtle:'CASH',mine:day===0&&trade?'LONG':'CASH'}))},
    }))};
}

test('historical batch verifies whole sorted disjoint windows and returns paired means and downside',async()=>{
  const data=await batchFixture();
  const report=compareLocalAccessoryBatch(data,base,batchModels.models.mine);
  assert.deepEqual(report.coverage,{codes:2,selected_windows:3,eligible_windows:694,
    period_start:'2024-01-01',period_end:'2024-03-13',lookback_days:24,simulation_days:12});
  assert.equal(report.weighting,'equal_per_window');
  assert.deepEqual(report.metrics.brier,{baseline_mean:.7,candidate_mean:.7,wins:1,ties:1,losses:1});
  assert.deepEqual(report.metrics.profit_coins,{baseline_mean:0,candidate_mean:-4.666667,wins:1,ties:1,losses:1});
  assert.equal(report.metrics.max_drawdown_pct.losses,2);
  assert.equal(report.metrics.max_drawdown_pct.ties,1);
  assert.equal(report.downside.candidate.worst_profit_coins,-356.65);
  // Both execution fees leave 9,643.35 of 10,000. The 3.5665% decline rounds to even.
  assert.equal(report.downside.candidate.max_drawdown_pct,3.566);
  assert.equal(report.different_signals,2);
  assert.equal(report.signal_comparisons,36);
  assert.deepEqual(report.by_code.map(row=>[row.code,row.windows,row.metrics.profit_coins.candidate_mean]),
    [['40050',2,-7],['46890',1,0]]);
  assert.match(report.notice,/12日間も含めて15%.*偏り/);
  assert.match(report.notice,/同じ市場や日程を共有/);
  assert.ok(!/future_prices|equity_path|market_id|"signals"|"windows":\[/.test(JSON.stringify(report)));

  for(const corrupt of [
    batch=>batch.windows.pop(),
    batch=>{batch.windows=[];batch.selected_windows=0;},
    batch=>{batch.selected_windows=41;batch.windows=Array(41).fill(batch.windows[0]);},
    batch=>batch.windows.reverse(),
    ({windows})=>{windows[1].market_id=windows[0].market_id;},
    ({windows})=>{windows[1].start_date=windows[0].end_date;},
    ({windows})=>{windows[1].history_end_date='2024-02-31';},
    ({windows})=>{windows[1].code='99999';},
    ({windows})=>{windows[1].eligible_windows=693;},
    ({windows})=>{windows[1].source_origin='JQUANTS_API_V2_CACHE';},
    ({windows})=>{windows[1].source='different provenance';},
    ({windows})=>{windows[1].source_warning='different warning';},
    ({windows})=>{windows[1].adjusted=true;},
    ({windows})=>{windows[1].plan.initial_price=99;},
    ({windows})=>{windows[1].plan.models.mine.effective_sha256='a'.repeat(64);},
    ({windows})=>{windows[1].plan.models.mine.plugin_weights=base.plugin_weights;},
    ({windows})=>{windows[1].plan.signals[0].turtle='LONG';},
    ({windows})=>{windows[1].brier.mine=3;},
  ]) {
    const modified=structuredClone(data);
    corrupt(modified);
    assert.throws(()=>compareLocalAccessoryBatch(modified,base,batchModels.models.mine),{status:503});
  }
});

test('batch HTTP requires strict local origin and current equipped rules, and exposes only read-only aggregates',async t=>{
  const {start,cp,part,local,snapshot,baselineSnapshot,equipment}=await fixture(t);
  const data=await batchFixture();
  let historyCalls=0,modelReads=0,fail;
  const api=await start({loadSnapshot:async()=>{modelReads++;return snapshot;},
    historicalBatchPredict:async (input,{signal})=>{
      historyCalls++;
      assert.deepEqual(input,batchModels);
      assert.ok(signal instanceof AbortSignal);
      if(fail==='missing')throw Error('synthetic private path');
      if(fail==='forged')return {...data,selected_windows:999};
      return data;
    }});
  const initial=compareInput(await api.get().then(r=>r.json()));
  const send=(input=initial,headers={})=>api.post(input,BATCH_HISTORY,headers);
  for(const bad of [null,[],{}, {...initial,source:'jquants'}, {...initial,code:'40050'},
    {...initial,weights:target},{...initial,start_date:'2024-01-01'},
    {...initial,replay_id:windowA},{...initial,exclude_id:windowB},{...initial,expected_revision:true}])
    assert.equal((await send(bad)).status,400);
  for(const headers of [{Origin:'https://outside.invalid'},{Origin:api.origin.replace('127.0.0.1','localhost')},{'Sec-Fetch-Site':'cross-site'}])
    assert.equal((await send(initial,headers)).status,403);
  const noOrigin=await fetch(api.origin+BATCH_HISTORY,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(initial)});
  assert.equal(noOrigin.status,403);
  const wrongHost=await new Promise((resolve,reject)=>{
    const outbound=request(api.origin+BATCH_HISTORY,{method:'POST',headers:{Host:'outside.invalid',Origin:api.origin}},res=>{
      res.resume();resolve(res.statusCode);
    });
    outbound.once('error',reject);
    outbound.end();
  });
  assert.equal(wrongHost,403);
  assert.equal((await api.get(BATCH_HISTORY)).status,404);
  assert.equal((await api.post(initial,BATCH_HISTORY+'?source=local')).status,404);
  assert.equal(modelReads,0);
  assert.equal((await send()).status,422);
  const context=await practiceContext(api);
  assert.equal((await send(initial)).status,409);
  assert.equal(historyCalls,0);

  const paths=[join(local,'accessory_analysis','analysis.json'),join(local,'character_equipment',cp+'.json'),
    join(local,'independent_parts',part.part_id,'part.png')];
  const before=await Promise.all(paths.map(path=>readFile(path)));
  const response=await send(context);
  const report=await response.json();
  assert.equal(response.status,200,JSON.stringify(report));
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');
  assert.equal(response.headers.get('access-control-allow-origin'),null);
  assert.equal(report.scope,'ACCESSORY_RULES_HISTORICAL_LOCAL_NONOVERLAP_V1');
  assert.equal(report.market.source_origin,'LOCAL_JPX_REPORT_CACHE_2024');
  assert.equal(report.market.adjusted,false);
  assert.equal(report.read_only,true);
  assert.equal(report.weights_changed,true);
  assert.equal(report.effective_hash_changed,true);
  for(const flag of ['trained','live_market','holdout_evaluated','persisted','save_performed','xp_awarded','coins_changed','order_placed'])
    assert.equal(report[flag],false);
  assert.deepEqual(report.provenance.applied_rules,[pin]);
  assert.equal(report.coverage.selected_windows,3);
  assert.deepEqual(await Promise.all(paths.map(path=>readFile(path))),before);
  assert.equal(JSON.stringify(snapshot),baselineSnapshot);

  fail='missing';
  const unavailable=await send(context);
  assert.equal(unavailable.status,503);
  assert.match((await unavailable.json()).error,/ローカルの2024年株価データを読み込めない/);
  fail='forged';
  const forged=await send(context);
  assert.equal(forged.status,503);
  assert.ok(!Object.hasOwn(await forged.json(),'metrics'));
  await equipment.save(cp,{expected_revision:1,parts:[{...part,visible:false}]});
  assert.equal((await send({...context,equipment_revision:2})).status,422);
  await equipment.save(cp,{expected_revision:2,parts:[{...part,image_sha256:'0'.repeat(64)}]});
  assert.equal((await send({...context,equipment_revision:3})).status,422);
  assert.equal(historyCalls,3);
});

test('batch HTTP rejects policy, equipment, active character, companion and model changes during computation',async t=>{
  const {start,cp,part,active,companion,equipment,snapshot}=await fixture(t);
  const setup=await start();
  const expected=await practiceContext(setup);
  const report=await batchFixture();
  let mutate;
  const api=await start({loadSnapshot:async()=>({...snapshot}),historicalBatchPredict:async()=>{
    await mutate();
    return report;
  }});
  for(const change of [
    ()=>{active.active_demo_id='cp_'+'b'.repeat(32);active.revision++;},
    ()=>equipment.save(cp,{expected_revision:1,parts:[{...part,x:1}]}),
    async()=>assert.equal((await setup.post({expected_revision:1,policies:[{...pin,intensity:2}]})).status,200),
    ()=>{snapshot.source_revision++;},
    ()=>{companion.revision++;},
  ]) {
    mutate=change;
    const response=await api.post(expected,BATCH_HISTORY);
    assert.equal(response.status,409,await response.text());
    active.active_demo_id=cp;
    Object.assign(expected,compareInput(await setup.get().then(r=>r.json())));
  }
});

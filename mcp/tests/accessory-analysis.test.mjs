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

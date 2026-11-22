import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,lstat,mkdtemp,readFile,rm,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGameServer,pythonPredict} from '../../game_runtime/server.mjs';
import {createCompanionStore,validateCompanion} from '../../game_runtime/companion.mjs';
import {createLookStore} from '../../game_runtime/looks.mjs';
import {createModelShopStore} from '../../game_runtime/model-shop.mjs';
import {runSyntheticGame} from '../../game_runtime/practice.mjs';
import {settleLeveragedPractice} from '../../game_runtime/leverage-practice.mjs';
import {createPracticeEngineSourceGuard} from '../../game_runtime/practice-engine-fingerprint.mjs';
import {createImportedCharacterStore} from '../../game_runtime/imported-characters.mjs';
const MODEL={fast_window:3,slow_window:9,risk_fraction:.35,
  plugin_weights:{trend:100,momentum:0,volatility:0,reversion:0},
  plugin_strengths:{trend:100,momentum:100,volatility:100,reversion:100}};
function snapshot(rev=2){
  return {state:{revision:rev,model:MODEL},
    lineup:{revision:1,slots:['owl','turtle'].map(slot=>({slot,model:MODEL}))},
    growth:{revision:0,slots:['mine','owl','turtle'].map(slot=>({slot,gear:'none'}))},
    source_revision:rev,lineup_revision:1,growth_revision:0};
}
const companion={revision:0,created:false,companion:null};
async function withServer(fn,options={}){
  const dir=await mkdtemp(join(tmpdir(),'creature-quick-'));
  const shop=createModelShopStore({file:join(dir,'shop.json')});
  const zipRoot=join(dir,'characters');
  const zip=createImportedCharacterStore({root:zipRoot});
  let writes=0,predictions=0;
  const server=createGameServer({
    store:{public:async()=>snapshot().growth,complete:()=>{writes++;throw Error('XP write')},
      equip:()=>{writes++;throw Error('gear write')}},
    companionStore:{read:options.readCompanion??(async()=>options.companion??companion),
      save:()=>{writes++;throw Error('companion write')}},
    importedCharacterStore:options.importedCharacterStore??zip,
    modelShopStore:options.modelShopStore??shop,
    practiceEngineSourceGuard:options.practiceEngineSourceGuard,
    loadSnapshot:options.loadSnapshot|| (async()=>snapshot()),
    predict:async plan=>{
      predictions++;
      const predicted=await pythonPredict(plan);
      await options.inspectPlan?.(plan,predicted);
      return predicted;
    },
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  try {await fn({base:'http://127.0.0.1:'+server.address().port,shop,zip,zipRoot,
    read:()=>({writes,predictions})});}
  finally {
    await new Promise(ok=>server.close(ok));
    await rm(dir,{recursive:true,force:true});
  }
}
async function post(base,body,headers={},path='/api/quick-practice'){
  const res=await fetch(base+path,{method:'POST',
    headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  return {status:res.status,data:await res.json()};
}
test('simple cash allocation 1 to 10000; no market, no persistence, no XP',async()=>{
  await withServer(async({base,read})=>{
    for(const amount of [1,1000,1234,10000]){
      const {status,data}=await post(base,{amount,model_id:'self'});
      assert.equal(status,200,JSON.stringify(data));
      assert.equal(data.mode,'SIMPLE_SYNTHETIC_PRACTICE_ONLY');
      assert.match(data.model_effective_sha256,/^[a-f0-9]{64}$/);
      assert.equal(data.companion_name,null);
      assert.equal(data.companion_strategy,null);
      assert.equal(data.invested_coins,amount);
      assert.equal(data.leverage,1,'legacy requests remain x1');
      assert.equal(data.normal_profit_coins,data.profit_coins);
      assert.equal(data.normal_final_balance,data.final_balance);
      assert.equal(data.normal_max_drawdown_pct,data.max_drawdown_pct);
      assert.equal(data.liquidated_at_step,null);
      assert.equal(data.initial_balance,10000);
      assert.equal(data.cash_held,10000-amount);
      assert.equal(data.steps,12);
      assert.equal(data.daily_ai_signals.length,12);
      assert.ok(data.daily_ai_signals.every(signal=>signal==='LONG'||signal==='CASH'));
      assert.equal(data.daily_synthetic_prices.length,13);
      assert.ok(data.daily_synthetic_prices.every(price=>Number.isFinite(price)&&price>0&&price<=1e12));
      assert.equal(data.daily_balances.length,13);
      assert.equal(data.daily_balances[0],10000);
      assert.equal(data.daily_balances[12],data.final_balance);
      assert.ok(data.daily_balances.every(n=>Number.isFinite(n)&&n>=data.cash_held));
      assert.ok(data.daily_balances.every(n=>Math.abs(n*100-Math.round(n*100))<1e-6));
      assert.equal(data.real_market,false);
      assert.equal(data.persisted,false);
      assert.equal(data.order_placed,false);
      assert.equal(data.xp_awarded,false);
      assert.ok(Math.abs(data.final_balance-(10000+data.profit_coins))<.02);
    }
    assert.deepEqual(read(),{writes:0,predictions:4});
    assert.equal((await fetch(base+'/quick-home.mjs')).status,200);
  });
});
test('25x server integration is read-only and never creates a negative balance',async()=>{
  const plans=[];
  await withServer(async({base,read})=>{
    const out=await post(base,{amount:1000,model_id:'self',leverage:25});
    assert.equal(out.status,200,JSON.stringify(out.data));
    assert.equal(out.data.leverage,25);
    assert.equal(out.data.daily_balances.length,13);
    assert.equal(out.data.daily_balances[0],10000);
    assert.equal(out.data.daily_balances[12],out.data.final_balance);
    assert.ok(out.data.daily_balances.every(n=>n>=9000));
    if(out.data.liquidated_at_step!==null) {
      assert.deepEqual(out.data.daily_balances.slice(out.data.liquidated_at_step),
        Array(13-out.data.liquidated_at_step).fill(9000));
    }
    assert.equal(out.data.cash_held,9000);
    assert.ok(Number.isFinite(out.data.normal_profit_coins));
    assert.ok(Number.isFinite(out.data.normal_final_balance));
    assert.ok(Number.isFinite(out.data.normal_max_drawdown_pct));
    assert.ok(Math.abs(out.data.normal_final_balance-
      (10000+out.data.normal_profit_coins))<.02);
    assert.equal(plans.length,1);
    const {raw_equity_path:equityPath}=runSyntheticGame({...plans[0],initial_coins:1000,
      allocations:{mine:100,owl:0,turtle:0}});
    // Each public profit is rounded separately, after applying its multiplier.
    const expected=settleLeveragedPractice({equityPath,amount:1000,leverage:25});
    const expectedNormal=settleLeveragedPractice({equityPath,amount:1000,leverage:1});
    assert.equal(out.data.profit_coins,expected.profit_coins);
    assert.equal(out.data.final_balance,expected.final_balance);
    assert.equal(out.data.max_drawdown_pct,expected.max_drawdown_pct);
    assert.equal(out.data.liquidated_at_step,expected.liquidated_at_step);
    assert.equal(out.data.normal_profit_coins,expectedNormal.profit_coins);
    assert.equal(out.data.normal_final_balance,expectedNormal.final_balance);
    assert.equal(out.data.normal_max_drawdown_pct,expectedNormal.max_drawdown_pct);
    if(out.data.liquidated_at_step!==null){
      assert.equal(out.data.profit_coins,-1000,
        'a liquidated allocation cannot recover');
    }
    assert.ok(out.data.final_balance>=9000);
    assert.ok(out.data.profit_coins>=-1000);
    assert.equal(out.data.real_market,false);
    assert.equal(out.data.persisted,false);
    assert.equal(out.data.order_placed,false);
    assert.equal(out.data.xp_awarded,false);
    assert.equal(out.data.steps,12);
    const normal=await post(base,{amount:1000,model_id:'self',leverage:1,scenario_token:out.data.scenario_token});
    assert.equal(normal.status,200);
    assert.equal(plans.length,2);
    assert.deepEqual(plans[1],plans[0]);
    assert.equal(normal.data.profit_coins,expectedNormal.profit_coins);
    assert.equal(normal.data.final_balance,expectedNormal.final_balance);
    assert.equal(normal.data.max_drawdown_pct,expectedNormal.max_drawdown_pct);
    assert.equal(normal.data.liquidated_at_step,expectedNormal.liquidated_at_step);
    assert.equal(out.data.daily_ai_signals.length,12);
    assert.equal(out.data.daily_synthetic_prices.length,13);
    assert.deepEqual(out.data.daily_ai_signals,normal.data.daily_ai_signals);
    assert.deepEqual(out.data.daily_synthetic_prices,normal.data.daily_synthetic_prices);
    assert.deepEqual(read(),{writes:0,predictions:2});
  },{inspectPlan:(_input,plan)=>plans.push(structuredClone(plan))});
});

test('reject malformed amount or model before forecast and cross-origin',async()=>{
  await withServer(async({base,read})=>{
    const bad=[
      {amount:0,model_id:'self'}, {amount:10001,model_id:'self'},
      {amount:1.2,model_id:'self'}, {amount:'1000',model_id:'self'},
      {amount:1000,model_id:'../evil'}, {amount:1000,model_id:'self',order:true},
      {amount:1000}, {amount:1000,model_id:123},
      ...[0,26,-1,1.5,'25',null].map(leverage=>({amount:1000,model_id:'self',leverage})),
      {amount:1000,model_id:'self',leverage:25,extra:true},
    ];
    for(const item of bad){
      const {status}=await post(base,item);
      assert.equal(status,400);
    }
    const denied=await post(base,{amount:1000,model_id:'self'},
      {Origin:'https://attacker.example'});
    assert.equal(denied.status,403);
    assert.deepEqual(read(),{writes:0,predictions:0});
  });
});
test('cannot use others model without purchase; single owned id usable',async()=>{
  await withServer(async({base,shop,read})=>{
    const state=await shop.public();
    const item=state.models[0];
    const locked=await post(base,{amount:2500,model_id:item.id});
    assert.equal(locked.status,403);
    await shop.purchase({id:item.id,expected_revision:state.revision});
    const output=await post(base,{amount:2500,model_id:item.id});
    assert.equal(output.status,200,JSON.stringify(output.data));
    assert.equal(output.data.model_id,item.id);
    assert.equal(output.data.companion_strategy,null);
    assert.equal(output.data.cash_held,7500);
    assert.equal((await shop.public()).coins,120);
    assert.deepEqual(read(),{writes:0,predictions:1});
  });
});

test('saved companion attribution is server-backed, self-only and read-only',async()=>{
  const saved={revision:1,created:true,companion:validateCompanion({
    name:'検証<&"相棒',hair_color:'#8882db',clothing_color:'#92e1d4',
    approach:'trend',risk_percent:35,
  })};
  const before=structuredClone(saved);
  let licenses=0;
  await withServer(async({base,read})=>{
    const self=await post(base,{amount:1000,model_id:'self'});
    const demo=await post(base,{amount:1000,model_id:'demo_stub',scenario_token:self.data.scenario_token});
    assert.equal(self.status,200,JSON.stringify(self.data));
    assert.equal(demo.status,200,JSON.stringify(demo.data));
    assert.equal(self.data.companion_name,saved.companion.name);
    assert.equal(demo.data.companion_name,null);
    assert.deepEqual(self.data.companion_strategy,{source:'saved_companion',approach:'trend',risk_percent:35});
    assert.equal(demo.data.companion_strategy,null);
    const {companion_name:selfName,companion_strategy:selfStrategy,model_id:selfId,scenario_kind:selfKind,scenario_notice:selfNotice,...selfResult}=self.data;
    const {companion_name:demoName,companion_strategy:demoStrategy,model_id:demoId,scenario_kind:demoKind,scenario_notice:demoNotice,...demoResult}=demo.data;
    assert.deepEqual(selfResult,demoResult,'attribution leaves calculation and prices identical');
    assert.deepEqual(saved,before);
    assert.equal(licenses,1);
    assert.deepEqual(read(),{writes:0,predictions:2});
  },{companion:saved,modelShopStore:{licensedModel:async id=>{
    assert.equal(id,'demo_stub');licenses++;return structuredClone(MODEL);
  }}});
});

test('strategy describes exactly the saved profile passed to prediction for self only',async()=>{
  for(const [approach,risk_percent] of [['trend',5],['momentum',100],['reversion',55],['volatility',70]]) {
    const saved={revision:3,created:true,companion:validateCompanion({
      name:'相棒',hair_color:'#8882db',clothing_color:'#92e1d4',approach,risk_percent,
    })};
    const plans=[];
    await withServer(async({base,read})=>{
      const self=await post(base,{amount:1000,model_id:'self'});
      const demo=await post(base,{amount:1000,model_id:'demo_stub',scenario_token:self.data.scenario_token});
      assert.equal(self.status,200);assert.equal(demo.status,200);
      assert.deepEqual(self.data.companion_strategy,{source:'saved_companion',approach,risk_percent});
      assert.equal(demo.data.companion_strategy,null);
      assert.deepEqual(plans[0].models.mine.plugin_weights,Object.fromEntries(
        ['trend','momentum','reversion','volatility'].map(key=>[key,key===approach?100:0])));
      assert.equal(plans[0].models.mine.risk_fraction,risk_percent/100);
      assert.deepEqual(plans[1].models.mine,MODEL);
      assert.deepEqual(read(),{writes:0,predictions:2});
    },{companion:saved,inspectPlan:plan=>plans.push(structuredClone(plan)),
      modelShopStore:{licensedModel:async()=>structuredClone(MODEL)}});
  }
});

test('risk changes capital use after LONG but never predictor signals or synthetic prices',async()=>{
  let differentProfits=0;
  for(const approach of ['trend','momentum','reversion','volatility']) {
    const results=[],plans=[];
    const source=snapshot(),sourceBefore=structuredClone(source);
    for(const risk_percent of [5,100]) {
      const saved={revision:1,created:true,companion:validateCompanion({
        name:'相棒',hair_color:'#8882db',clothing_color:'#92e1d4',approach,risk_percent,
      })};
      const before=structuredClone(saved);
      await withServer(async({base,read})=>{
        const {status,data}=await post(base,{amount:1000,model_id:'self',leverage:1,scenario_token:'v1_0123456789abcdef'});
        assert.equal(status,200,JSON.stringify(data));
        assert.deepEqual(data.companion_strategy,{source:'saved_companion',approach,risk_percent});
        assert.equal(data.persisted,false);assert.equal(data.xp_awarded,false);
        assert.equal(data.order_placed,false);
        assert.deepEqual(read(),{writes:0,predictions:1});
        assert.deepEqual(saved,before);
        assert.deepEqual(source,sourceBefore);
        results.push(data);
      },{companion:saved,loadSnapshot:async()=>source,inspectPlan:plan=>plans.push(structuredClone(plan))});
    }
    assert.equal(plans[0].models.mine.risk_fraction,.05);
    assert.equal(plans[1].models.mine.risk_fraction,1);
    const normalized=plans.map(plan=>({...plan,models:{...plan.models,
      mine:{...plan.models.mine,risk_fraction:.35}}}));
    assert.deepEqual(normalized[0],normalized[1],'only the saved capital fraction differs');
    assert.deepEqual(results[0].daily_synthetic_prices,results[1].daily_synthetic_prices);
    assert.deepEqual(results[0].daily_ai_signals,results[1].daily_ai_signals,
      `${approach}: risk must not change the predicted direction`);
    if(results[0].daily_ai_signals.includes('LONG')) {
      assert.notEqual(results[0].profit_coins,results[1].profit_coins,
        `${approach}: capital use changes the synthetic profit for this scenario`);
      differentProfits++;
    } else {
      assert.equal(results[0].profit_coins,0);assert.equal(results[1].profit_coins,0);
    }
  }
  assert.ok(differentProfits>0,'exercise LONG capital use as well as signal invariance');
});

import {Readable} from 'node:stream';
import {roundingPlan} from './audit74-fixture.mjs';
function directRequest(server,url,{method='GET',body,remote='127.0.0.1'}={}) {
  return new Promise(resolve=>{
    const encoded=body?JSON.stringify(body):'';
    const req=Readable.from(encoded?[Buffer.from(encoded)]:[]);
    Object.assign(req,{url,method,socket:{remoteAddress:remote},headers:{host:'localhost:undefined',
      'content-type':'application/json','content-length':String(Buffer.byteLength(encoded))}});
    const res={writeHead(status,headers){this.status=status;this.headers=headers;},
      end(data){resolve({status:this.status,data:data?JSON.parse(String(data)):null});}};
    server.emit('request',req,res);
  });
}
test('QuickHome uses saved judgment rules after cosmetic changes, with no legacy opt-in',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'quick-appearance-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const companionStore=createCompanionStore({file:join(dir,'companion.json')});
  const lookStore=createLookStore({file:join(dir,'look.json')});
  const server=createGameServer({loadSnapshot:async()=>snapshot(),companionStore,lookStore});
  const post=(url,body)=>directRequest(server,url,{method:'POST',body});
  const profile={name:'相棒',hair_color:'#0000ff',clothing_color:'#0000ff',approach:'reversion',risk_percent:100};
  const body={model_id:'self',amount:1000,scenario_token:'v1_0000000000000009'};
  await companionStore.save({expected_revision:0,companion:profile});
  const before=await post('/api/quick-practice',body);
  assert.equal(before.status,200,JSON.stringify(before.data));
  await lookStore.save({expected_revision:0,look:{hair_style:'long',expression:'determined',accessory:'star'}});
  await companionStore.save({expected_revision:1,companion:{...profile,hair_color:'#ff0000'}});
  const after=await post('/api/quick-practice',body);
  assert.deepEqual(after,before);
  assert.equal(after.data.daily_ai_signals.length,12);
  assert.equal(after.data.companion_strategy.approach,'reversion');
  assert.equal((await post('/api/quick-practice',
    {...body,appearance_model_version:'appearance-v1_42_23_23_12_50'})).status,400);
});

test('audit74: malformed request target returns 400 and health survives without sockets',async()=>{
  const server=createGameServer();
  for(const url of ['//[',undefined,'','http://localhost/health','//localhost/health','/\\evil','/health#x','/bad%xx']) {
    assert.equal((await directRequest(server,url)).status,400);
    assert.equal((await directRequest(server,'/health')).status,200);
  }
  assert.equal((await directRequest(server,'//[',{remote:'192.0.2.1'})).status,403);
  assert.equal((await directRequest(server,'/health?ok=1')).status,200);
});
test('audit74: quick-practice uses unrounded equity without exposing it',async()=>{
  const server=createGameServer({loadSnapshot:async()=>snapshot(),
    companionStore:{read:async()=>companion},predict:async()=>roundingPlan()});
  const out=await directRequest(server,'/api/quick-practice',{method:'POST',body:{amount:1,model_id:'self',leverage:25}});
  assert.equal(out.status,200);
  assert.equal(out.data.liquidated_at_step,null);
  assert.equal(out.data.final_balance,10000.25);
  assert.equal(JSON.stringify(out.data).includes('raw_equity_path'),false);
});

test('sprint75: token validation precedes prediction; new and replay are read-only',async()=>{
  let calls=0;
  const server=createGameServer({loadSnapshot:async()=>snapshot(),
    companionStore:{read:async()=>companion},predict:async input=>{
      calls++; return pythonPredict(input);
    }});
  const run=body=>directRequest(server,'/api/quick-practice',{method:'POST',body});
  const body={amount:1000,model_id:'self'};
  for(const token of [null,12,{},[],true,'','v2_0123456789abcdef','v1_0123456789ABCDEF',
    'v1_0123456789abcdef\n','v1_0123456789abcdef0','x'.repeat(65)]) {
    assert.equal((await run({...body,scenario_token:token})).status,400);
  }
  assert.equal((await run({...body,scenario_token:'v1_0123456789abcdef',seed:1})).status,400);
  assert.equal((await run({...body,engine_source_sha256:'a'.repeat(64)})).status,400);
  assert.equal(calls,0);
  const fresh=await run(body);
  assert.equal(fresh.status,200,JSON.stringify(fresh.data));
  assert.match(fresh.data.scenario_token,/^v1_[0-9a-f]{16}$/);
  assert.equal(fresh.data.scenario_kind,'new');
  assert.ok(Buffer.byteLength(JSON.stringify({...body,scenario_token:fresh.data.scenario_token}))-
    Buffer.byteLength(JSON.stringify(body))<=64);
  const replay=await run({...body,scenario_token:fresh.data.scenario_token});
  assert.equal(replay.status,200);
  assert.equal(replay.data.scenario_kind,'replay');
  assert.match(replay.data.scenario_notice,/初見の予想とは比較できません/);
  assert.deepEqual(replay.data.daily_synthetic_prices,fresh.data.daily_synthetic_prices);
  assert.deepEqual(replay.data.daily_ai_signals,fresh.data.daily_ai_signals);
  assert.equal(replay.data.profit_coins,fresh.data.profit_coins);
  const second=await run({...body,amount:2500,leverage:7});
  assert.equal(second.status,200);
  assert.notEqual(second.data.scenario_token,fresh.data.scenario_token);
  assert.notDeepEqual(second.data.daily_synthetic_prices,fresh.data.daily_synthetic_prices);
  for(const {data} of [fresh,replay,second]) {
    assert.match(data.model_effective_sha256,/^[a-f0-9]{64}$/);
    assert.equal(data.model_effective_sha256,fresh.data.model_effective_sha256);
    assert.match(data.engine_source_sha256,/^[a-f0-9]{64}$/);
    assert.equal(data.engine_source_sha256,fresh.data.engine_source_sha256);
    for(const flag of ['persisted','xp_awarded','order_placed','real_market'])assert.equal(data[flag],false);
  }
  assert.equal(calls,3);
});

test('P9s reports the effective fingerprint after each saved companion settings update',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'quick-fingerprint-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const companionStore=createCompanionStore({file:join(dir,'companion.json')});
  const shop=createModelShopStore({file:join(dir,'shop.json')});
  const server=createGameServer({loadSnapshot:async()=>snapshot(),companionStore,modelShopStore:shop});
  const run=model_id=>directRequest(server,'/api/quick-practice',{method:'POST',body:{
    model_id,amount:1000,scenario_token:'v1_0123456789abcdef',
  }});
  const modelShop=await shop.public();
  const demoId=modelShop.models[0].id;
  await shop.purchase({id:demoId,expected_revision:modelShop.revision});
  const profile={name:'相棒',hair_color:'#8882db',clothing_color:'#92e1d4',approach:'trend',risk_percent:35};
  const hashes=[],engineHashes=[];
  for(const [revision,settings] of [
    [0,profile],[1,{...profile,approach:'reversion'}],[2,{...profile,approach:'reversion',risk_percent:80}],
  ]) {
    await companionStore.save({expected_revision:revision,companion:settings});
    const result=await run('self');
    assert.equal(result.status,200,JSON.stringify(result.data));
    assert.match(result.data.model_effective_sha256,/^[a-f0-9]{64}$/);
    hashes.push(result.data.model_effective_sha256);
    engineHashes.push(result.data.engine_source_sha256);
  }
  assert.equal(new Set(hashes).size,3);
  const demo=await run(demoId);
  assert.equal(demo.status,200,JSON.stringify(demo.data));
  assert.match(demo.data.model_effective_sha256,/^[a-f0-9]{64}$/);
  assert.notEqual(demo.data.model_effective_sha256,hashes.at(-1));
  assert.match(demo.data.engine_source_sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(engineHashes,Array(3).fill(demo.data.engine_source_sha256));
});

test('P9t rejects file drift before and during prediction, and requires matching startup baselines',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'quick-engine-source-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=join(dir,'engine.py');
  const original=new URL('../../engine.py',import.meta.url);
  const restore=()=>copyFile(original,source);
  const change=()=>writeFile(source,'# changed source\n');
  const body={amount:1000,model_id:'self'};
  await restore();
  const createGuard=()=>createPracticeEngineSourceGuard({sources:[['engine.py',source]]});
  const guard=createGuard();
  const failClosed=({status,data},expected)=>{
    assert.equal(status,expected,JSON.stringify(data));
    assert.deepEqual(Object.keys(data).sort(),['code','error']);
    assert.equal(data.code,'PRACTICE_ENGINE_SOURCE_UNVERIFIED');
  };
  let editDuringPrediction=false;
  let originalHash;
  await withServer(async({base,shop,read})=>{
    const shopBefore=await shop.public();
    const healthy=await post(base,body);
    assert.equal(healthy.status,200);
    originalHash=healthy.data.engine_source_sha256;
    assert.equal(originalHash,guard.baseline);
    await change();
    failClosed(await post(base,body),409);
    await unlink(source);
    failClosed(await post(base,body),503);
    const health=await fetch(base+'/health');
    assert.equal(health.status,200);
    assert.equal(Object.hasOwn(await health.json(),'engine_source_sha256'),false);
    assert.deepEqual(read(),{writes:0,predictions:1});
    await restore();
    editDuringPrediction=true;
    failClosed(await post(base,body),409);
    assert.deepEqual(read(),{writes:0,predictions:2});
    await restore();
    const recovered=await post(base,body);
    assert.equal(recovered.status,200);
    assert.equal(recovered.data.engine_source_sha256,originalHash);
    assert.deepEqual(await shop.public(),shopBefore);
    assert.deepEqual(read(),{writes:0,predictions:3});
  },{practiceEngineSourceGuard:guard,inspectPlan:async()=>{
    if(editDuringPrediction){editDuringPrediction=false;await change();}
  }});

  await change();
  await withServer(async({base,read})=>{
    failClosed(await post(base,body),409);
    assert.deepEqual(read(),{writes:0,predictions:0});
  },{practiceEngineSourceGuard:guard});
  // Capture both baselines again, as a new process would after loading new code.
  await withServer(async({base,read})=>{
    const restarted=await post(base,body);
    assert.equal(restarted.status,200);
    assert.notEqual(restarted.data.engine_source_sha256,originalHash);
    assert.deepEqual(read(),{writes:0,predictions:1});
  },{practiceEngineSourceGuard:createGuard()});
  await unlink(source);
  await withServer(async({base,read})=>{
    await restore();
    failClosed(await post(base,body),503);
    assert.deepEqual(read(),{writes:0,predictions:0});
  },{practiceEngineSourceGuard:createGuard()});
});

test('P9s changes the self fingerprint when source model parameters change under the same companion strategy',async()=>{
  const profile={name:'相棒',hair_color:'#8882db',clothing_color:'#92e1d4',approach:'trend',risk_percent:35};
  const saved={revision:1,created:true,companion:validateCompanion(profile)};
  let source=snapshot();
  await withServer(async({base})=>{
    const body={model_id:'self',amount:1000,leverage:1,scenario_token:'v1_0123456789abcdef'};
    const before=await post(base,body);
    const rev=source.source_revision+1;
    source={...snapshot(rev),state:{revision:rev,model:{
      ...MODEL,plugin_strengths:{...MODEL.plugin_strengths,trend:75},
    }}};
    const after=await post(base,body);
    const strategy={source:'saved_companion',approach:'trend',risk_percent:35};
    for(const result of [before,after]) {
      assert.equal(result.status,200,JSON.stringify(result.data));
      assert.deepEqual(result.data.companion_strategy,strategy);
      assert.match(result.data.model_effective_sha256,/^[a-f0-9]{64}$/);
    }
    assert.notEqual(after.data.model_effective_sha256,before.data.model_effective_sha256);
  },{companion:saved,loadSnapshot:async()=>source});
});

test('P9s ZIP fingerprints reflect the equipped analysis even with identical prediction parameters',async()=>{
  const modelId='zip_'+'c'.repeat(32);
  let methods=['bollinger_breakout','rsi_oversold'];
  const server=createGameServer({loadSnapshot:async()=>snapshot(),
    companionStore:{read:async()=>companion},
    importedCharacterStore:{model:async id=>{
      assert.equal(id,modelId);
      return {name:'装備付き',model:MODEL,accessory_methods:methods};
    }},
  });
  const run=async scenario_token=>{
    const result=await directRequest(server,'/api/quick-practice',{method:'POST',body:{
      model_id:modelId,amount:1000,scenario_token,
    }});
    assert.equal(result.status,200,JSON.stringify(result.data));
    assert.match(result.data.model_effective_sha256,/^[a-f0-9]{64}$/);
    return result.data.model_effective_sha256;
  };
  const original=await run('v1_0123456789abcdef');
  assert.equal(await run('v1_ffffffffffffffff'),original);
  methods=['bollinger_breakout','macd_momentum'];
  assert.notEqual(await run('v1_0123456789abcdef'),original);
});

const accessoryPath='/api/accessory-control';
const accessoryBody={model_id:'self',accessory_a:'star',accessory_b:'glasses',amount:1000,leverage:5};
const postAccessory=(base,patch={},path=accessoryPath)=>post(base,{...accessoryBody,...patch},{},path);
const zipId='zip_'+'f'.repeat(32);
const testSha='a'.repeat(64);

test('accessory control compares real Python plans with only the strategy changed',async()=>{
  const inputs=[],plans=[];
  const saved={revision:1,created:true,companion:{approach:'momentum',risk_percent:50}};
  await withServer(async({base,shop,read})=>{
    const before=await shop.public();
    const {status,data}=await postAccessory(base);
    assert.equal(status,200,JSON.stringify(data));
    assert.equal(data.mode,'CONTROLLED_SYNTHETIC_ACCESSORY_ONLY');
    for(const key of ['persisted','order_placed','xp_awarded','real_market'])assert.equal(data[key],false);
    assert.equal(data.model_id,'self');
    assert.equal(data.amount,1000);
    assert.equal(data.leverage,5);
    assert.match(data.engine_source_sha256,/^[a-f0-9]{64}$/);
    assert.match(data.baseline_fingerprint,/^[a-f0-9]{64}$/);
    assert.match(data.scenario_token,/^v1_[a-f0-9]{16}$/);
    assert.equal(inputs.length,2);
    assert.deepEqual(inputs[1],{...inputs[0],accessory_strategy:'glasses'});
    assert.equal(inputs[0].accessory_strategy,'star');
    assert.equal(inputs[0].scenario_token,data.scenario_token);
    assert.equal(inputs[0].models.mine.risk_fraction,.5);
    assert.equal(inputs[0].models.mine.plugin_weights.momentum,100);
    assert.equal(data.daily_synthetic_prices.length,13);
    for(const [index,arm] of [data.a,data.b].entries()){
      const plan=plans[index];
      assert.equal(arm.accessory,inputs[index].accessory_strategy);
      assert.match(arm.model_effective_sha256,/^[a-f0-9]{64}$/);
      assert.deepEqual(data.daily_synthetic_prices,[plan.initial_price,...plan.future_prices]);
      const game=runSyntheticGame({...plan,initial_coins:1000,allocations:{mine:100,owl:0,turtle:0}});
      assert.deepEqual(arm.daily_ai_signals,game.decisions.map(({signals})=>signals.mine));
      const settled=settleLeveragedPractice({equityPath:game.raw_equity_path,amount:1000,leverage:5});
      for(const key of ['profit_coins','max_drawdown_pct','liquidated_at_step'])assert.equal(arm[key],settled[key]);
    }
    assert.notEqual(data.a.model_effective_sha256,data.b.model_effective_sha256);
    assert.deepEqual(await shop.public(),before);
    assert.deepEqual(read(),{writes:0,predictions:2});
  },{companion:saved,inspectPlan:(input,plan)=>{inputs.push(input);plans.push(plan);}});
});

test('accessory control rejects malformed input, demo, scenario reuse, queries and unsupported methods',async()=>{
  await withServer(async({base,read})=>{
    for(const patch of [{model_id:'demo_one'},{model_id:zipId+'\n'},{model_id:true},
      {accessory_a:'STAR'},{accessory_b:'star'},{accessory_a:true},{accessory_b:null},
      {amount:0},{amount:10001},{amount:true},{amount:1.5},{leverage:0},{leverage:'2'},
      {leverage:26},{leverage:undefined},{scenario_token:'v1_0123456789abcdef'},
      {models:{}},{accessory_methods:[]},{'extra|field':1}]) {
      assert.equal((await postAccessory(base,patch)).status,400,JSON.stringify(patch));
    }
    for(const suffix of ['?foo=1','/other'])assert.equal((await postAccessory(base,{},accessoryPath+suffix)).status,404);
    assert.equal((await fetch(base+accessoryPath)).status,404);
    assert.equal((await post(base,{model_id:'self',amount:1000,accessory_strategy:'star'})).status,400);
    for(const [body,status] of [['{"amount":',400],[' '.repeat(2049),413]]) {
      assert.equal((await fetch(base+accessoryPath,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,status);
    }
    assert.deepEqual(read(),{writes:0,predictions:0});
  });
});

test('accessory ZIP lookup does not create missing storage or rewrite registered records',async()=>{
  const png={mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGMMqFjAwMDAxMDAwMDAAAAQugFsZnyF3gAAAABJRU5ErkJggg=='};
  const images={body:png,ready:png,portrait:png};
  const colors={hair_color:'#a58bd9',clothing_color:'#78c2c5'};
  const look={hair_style:'bob',expression:'cheerful',accessory:'none'};
  const inputs=[];
  await withServer(async({base,zip,zipRoot,read})=>{
    assert.equal((await postAccessory(base,{model_id:zipId})).status,404);
    await assert.rejects(lstat(zipRoot),{code:'ENOENT'});
    assert.deepEqual(read(),{writes:0,predictions:0});
    const legacy=await zip.register({name:'Legacy',look:{...look,accessory:'ribbon'},images,colors});
    const equipped=await zip.register({name:'Equipped',look,images,colors,accessories:['star','glasses']});
    const listed=await zip.list();
    assert.deepEqual(listed.characters.map(({id})=>id).sort(),[legacy.id,equipped.id].sort());
    for(const registered of [legacy,equipped]){
      const saved=await zip.model(registered.id);
      assert.deepEqual(await zip.model(registered.id,{readOnly:true}),saved);
      const file=join(zipRoot,registered.id+'.json');
      const before=await readFile(file);
      const {status,data}=await postAccessory(base,{model_id:registered.id,accessory_b:'none'});
      assert.equal(status,200,JSON.stringify(data));
      assert.equal(data.model_id,registered.id);
      assert.equal(data.b.accessory,'none');
      assert.deepEqual(await readFile(file),before);
      assert.deepEqual(await zip.model(registered.id),saved);
      assert.ok(inputs.slice(-2).every(input=>!Object.hasOwn(input,'accessory_methods')));
      assert.deepEqual(inputs.at(-2).models.mine,saved.model);
    }
    assert.deepEqual(await zip.list(),listed);
    assert.equal((await postAccessory(base,{model_id:zipId})).status,404);
    await writeFile(join(zipRoot,legacy.id+'.json'),'{}');
    assert.equal((await postAccessory(base,{model_id:legacy.id})).status,503);
    assert.deepEqual(read(),{writes:0,predictions:4});
  },{inspectPlan:input=>{inputs.push(input);}});
});

test('accessory control fails closed when snapshot, companion or registered ZIP revisions change',async()=>{
  for(const key of ['source_revision','lineup_revision','growth_revision','companion',
    'model_version','model_revision','equipment_hash','accessory_strategy','removed']){
    let changed=false;
    const imported={model:MODEL,model_version:'original',model_revision:1,
      equipment_hash:testSha,accessory_strategy:'ribbon'};
    const needsZip=Object.hasOwn(imported,key)||key==='removed';
    await withServer(async({base,read})=>{
      const result=await postAccessory(base,{model_id:needsZip?zipId:'self'});
      assert.equal(result.status,409,key);
      assert.equal(result.data.a,undefined);
      assert.deepEqual(read(),{writes:0,predictions:2});
    },{
      loadSnapshot:async()=>({...snapshot(),...(changed && key.endsWith('_revision')&&!needsZip?{[key]:42}:{})}),
      readCompanion:async()=>({...companion,revision:changed&&key==='companion'?1:0}),
      importedCharacterStore:{model:async(id,options)=>{
        assert.equal(id,zipId);
        assert.deepEqual(options,{readOnly:true});
        if(changed&&key==='removed')throw Object.assign(Error('missing'),{status:404});
        return changed?{...imported,[key]:'changed'}:imported;
      }},
      inspectPlan:input=>{if(input.accessory_strategy==='glasses')changed=true;},
    });
  }
});

test('accessory control checks engine source before, between and after predictions, even on failure',async()=>{
  for(const [driftAt,status,expectedCalls] of [[0,409,0],[1,409,1],[2,409,2],[2,503,2]]){
    let calls=0;
    const guard={baseline:testSha,captureBaseline:()=>testSha,read:async()=>{
      if(calls!==driftAt)return testSha;
      if(status===503)throw Error('missing');
      return 'b'.repeat(64);
    }};
    await withServer(async({base,read})=>{
      const result=await postAccessory(base);
      assert.equal(result.status,status,JSON.stringify(result.data));
      assert.equal(result.data.code,'PRACTICE_ENGINE_SOURCE_UNVERIFIED');
      assert.equal(result.data.a,undefined);
      assert.deepEqual(read(),{writes:0,predictions:expectedCalls});
    },{practiceEngineSourceGuard:guard,inspectPlan:()=>{
      calls++;
      if(status===503&&calls===driftAt)throw Error('prediction failed');
    }});
  }
});

test('accessory control rejects plans with mismatched prices, numeric model or fingerprints',async()=>{
  for(const damage of [
    plan=>{plan.initial_price+=1;},
    plan=>{plan.future_prices[11]+=1;},
    plan=>{plan.future_prices.pop();},
    plan=>{plan.models.mine.risk_fraction=.5;},
    plan=>{plan.models.mine.plugin_weights.trend=99;},
    plan=>{plan.models.mine.plugin_strengths.trend=99;},
    plan=>{plan.models.mine.effective_sha256='unsafe';},
    (plan,first)=>{plan.models.mine.effective_sha256=first.models.mine.effective_sha256;},
  ]){
    let first;
    await withServer(async({base})=>{
      const result=await postAccessory(base);
      assert.equal(result.status,503);
      assert.equal(result.data.a,undefined);
    },{inspectPlan:(input,plan)=>{
      if(input.accessory_strategy==='star')first=plan;
      else damage(plan,first);
    }});
  }
});

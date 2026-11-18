import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGameServer,pythonPredict} from '../../game_runtime/server.mjs';
import {createCompanionStore,validateCompanion} from '../../game_runtime/companion.mjs';
import {createLookStore} from '../../game_runtime/looks.mjs';
import {createModelShopStore} from '../../game_runtime/model-shop.mjs';
import {runSyntheticGame} from '../../game_runtime/practice.mjs';
import {settleLeveragedPractice} from '../../game_runtime/leverage-practice.mjs';
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
  let writes=0,predictions=0;
  const server=createGameServer({
    store:{public:async()=>snapshot().growth,complete:()=>{writes++;throw Error('XP write')},
      equip:()=>{writes++;throw Error('gear write')}},
    companionStore:{read:async()=>options.companion??companion,save:()=>{writes++;throw Error('companion write')}},
    modelShopStore:options.modelShopStore??shop,
    loadSnapshot:options.loadSnapshot|| (async()=>snapshot()),
    predict:async plan=>{
      predictions++;
      const predicted=await pythonPredict(plan);
      options.inspectPlan?.(plan,predicted);
      return predicted;
    },
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  try {await fn({base:'http://127.0.0.1:'+server.address().port,shop,
    read:()=>({writes,predictions})});}
  finally {
    await new Promise(ok=>server.close(ok));
    await rm(dir,{recursive:true,force:true});
  }
}
async function post(base,body,headers={}){
  const res=await fetch(base+'/api/quick-practice',{method:'POST',
    headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  return {status:res.status,data:await res.json()};
}
test('simple cash allocation 1 to 10000; no market, no persistence, no XP',async()=>{
  await withServer(async({base,read})=>{
    for(const amount of [1,1000,1234,10000]){
      const {status,data}=await post(base,{amount,model_id:'self'});
      assert.equal(status,200,JSON.stringify(data));
      assert.equal(data.mode,'SIMPLE_SYNTHETIC_PRACTICE_ONLY');
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
test('quick appearance model uses the saved settings in the Python forecast and JS settlement',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'quick-appearance-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const companionStore=createCompanionStore({file:join(dir,'companion.json')});
  const lookStore=createLookStore({file:join(dir,'look.json')});
  const server=createGameServer({loadSnapshot:async()=>snapshot(),companionStore,lookStore});
  const post=(url,body)=>directRequest(server,url,{method:'POST',body});
  const preview=()=>directRequest(server,'/api/companion/appearance-model');
  const amount=1000;
  const body={model_id:'self',amount,scenario_token:'v1_0000000000000009'};
  const run=extra=>post('/api/quick-practice',{...body,...extra});
  const profile={name:'相棒',hair_color:'#0000ff',clothing_color:'#0000ff',approach:'reversion',risk_percent:100};
  const look={hair_style:'bob',expression:'calm',accessory:'none'};
  assert.equal((await post('/api/companion',{expected_revision:0,companion:profile})).status,200);
  const unsaved=(await preview()).data;
  assert.equal(unsaved.look_created,false);
  assert.equal((await run({appearance_model_version:unsaved.model_version})).status,409);
  assert.equal((await post('/api/looks',{expected_revision:0,look})).status,200);
  const {data:appearance}=await preview();
  const appearance_model_version=appearance.model_version;
  assert.equal((await run({appearance_model_version,model_id:'demo_owl'})).status,400);
  assert.equal((await run({appearance_model_version:null})).status,400);
  const result=await run({appearance_model_version});
  assert.equal(result.status,200,JSON.stringify(result.data));
  assert.deepEqual(result.data.brain,{kind:'appearance_model',version_id:appearance_model_version});
  assert.equal(result.data.companion_name,'相棒');
  assert.equal(result.data.companion_strategy,null);
  const plan=await pythonPredict({base_model:MODEL,models:{mine:{...MODEL,...appearance.model},
    owl:MODEL,turtle:MODEL},scenario_token:body.scenario_token});
  const game=runSyntheticGame({...plan,initial_coins:amount,allocations:{mine:100,owl:0,turtle:0}});
  assert.deepEqual(result.data.daily_ai_signals,game.decisions.map(day=>day.signals.mine));
  const expected=settleLeveragedPractice({equityPath:game.raw_equity_path,amount,leverage:1});
  assert.equal(result.data.profit_coins,expected.profit_coins);
  assert.notEqual(result.data.profit_coins,0);
  const standard=await run();
  assert.equal(standard.status,200,JSON.stringify(standard.data));
  assert.equal(standard.data.brain,undefined);
  assert.equal(standard.data.companion_strategy.approach,'reversion');
  assert.deepEqual(standard.data.daily_synthetic_prices,result.data.daily_synthetic_prices);
  assert.notDeepEqual(standard.data.daily_ai_signals,result.data.daily_ai_signals);
  assert.equal((await post('/api/looks',{expected_revision:1,look:{...look,expression:'determined'}})).status,200);
  assert.equal((await run({appearance_model_version})).status,409);
});

test('saving either appearance input during the real forecast invalidates quick practice',async()=>{
  const look={hair_style:'bob',expression:'cheerful',accessory:'none'};
  const profile={name:'相棒',hair_color:'#808080',clothing_color:'#808080',approach:'trend',risk_percent:50};
  for(const edited of ['companion','look']) {
    const revisions={companion:1,look:1};
    const server=createGameServer({loadSnapshot:async()=>snapshot(),
      companionStore:{read:async()=>({created:true,revision:revisions.companion,companion:profile})},
      lookStore:{read:async()=>({created:true,revision:revisions.look,look})},
      predict:async plan=>{
        const prediction=await pythonPredict(plan);
        revisions[edited]++;
        return prediction;
      },
    });
    const {data}=await directRequest(server,'/api/companion/appearance-model');
    const result=await directRequest(server,'/api/quick-practice',{method:'POST',body:{
      model_id:'self',amount:1000,appearance_model_version:data.model_version,
    }});
    assert.equal(result.status,409,JSON.stringify(result.data));
    assert.equal(result.data.daily_ai_signals,undefined);
  }
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
  const second=await run(body);
  assert.equal(second.status,200);
  assert.notEqual(second.data.scenario_token,fresh.data.scenario_token);
  assert.notDeepEqual(second.data.daily_synthetic_prices,fresh.data.daily_synthetic_prices);
  for(const {data} of [fresh,replay,second]) {
    for(const flag of ['persisted','xp_awarded','order_placed','real_market'])assert.equal(data[flag],false);
  }
  assert.equal(calls,3);
});

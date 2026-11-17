import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGameServer,pythonPredict} from '../../game_runtime/server.mjs';
import {validateCompanion} from '../../game_runtime/companion.mjs';
import {createModelShopStore} from '../../game_runtime/model-shop.mjs';
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
    predict:async plan=>{predictions++;options.inspectPlan?.(plan);return pythonPredict(plan);},
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
    if(out.data.liquidated_at_step===null){
      assert.ok(Math.abs(out.data.profit_coins-
        25*out.data.normal_profit_coins)<.03);
    } else {
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
    const normal=await post(base,{amount:1000,model_id:'self',leverage:1});
    assert.equal(normal.status,200);
    assert.equal(out.data.daily_ai_signals.length,12);
    assert.equal(out.data.daily_synthetic_prices.length,13);
    assert.deepEqual(out.data.daily_ai_signals,normal.data.daily_ai_signals);
    assert.deepEqual(out.data.daily_synthetic_prices,normal.data.daily_synthetic_prices);
    assert.deepEqual(read(),{writes:0,predictions:2});
  });
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
    const demo=await post(base,{amount:1000,model_id:'demo_stub'});
    assert.equal(self.status,200,JSON.stringify(self.data));
    assert.equal(demo.status,200,JSON.stringify(demo.data));
    assert.equal(self.data.companion_name,saved.companion.name);
    assert.equal(demo.data.companion_name,null);
    assert.deepEqual(self.data.companion_strategy,{source:'saved_companion',approach:'trend',risk_percent:35});
    assert.equal(demo.data.companion_strategy,null);
    const {companion_name:selfName,companion_strategy:selfStrategy,model_id:selfId,...selfResult}=self.data;
    const {companion_name:demoName,companion_strategy:demoStrategy,model_id:demoId,...demoResult}=demo.data;
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
      const demo=await post(base,{amount:1000,model_id:'demo_stub'});
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

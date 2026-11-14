import test from 'node:test';
import assert from 'node:assert/strict';
import {createGameServer,pythonPredict} from '../../game_runtime/server.mjs';
import {validateLabModel,validateLabRevisions,compareLabPlan} from '../../game_runtime/model-lab.mjs';

const weights={trend:100,momentum:0,volatility:0,reversion:0};
const strengths={trend:100,momentum:100,volatility:100,reversion:100};
const model=(changes={})=>({fast_window:3,slow_window:9,risk_fraction:.35,
  plugin_weights:{...weights},plugin_strengths:{...strengths},...changes});
const snapshot=(revision=3)=>({
  state:{revision,model:model()},
  lineup:{revision:2,slots:[
    {slot:'owl',model:model({plugin_weights:{trend:0,momentum:100,volatility:0,reversion:0}})},
    {slot:'turtle',model:model({plugin_weights:{trend:0,momentum:0,volatility:0,reversion:100}})}]},
  growth:{revision:5,slots:['mine','owl','turtle'].map(slot=>({slot,gear:'spark_charm'}))},
  source_revision:revision,lineup_revision:2,growth_revision:5,
});
const companion={created:true,revision:7,companion:{
  name:'研究用の女の子',hair_color:'#abcdef',clothing_color:'#aabbcc',
  approach:'momentum',risk_percent:65,
}};
async function withServer(config,fn){
  const server=createGameServer(config);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await fn('http://127.0.0.1:'+server.address().port);}
  finally{await new Promise(resolve=>server.close(resolve));}
}
async function get(base){const r=await fetch(base+'/api/model-lab/baseline');return {r,data:await r.json()};}
async function compare(base,candidate,revisions,headers={}){
  const r=await fetch(base+'/api/model-lab/compare',{
    method:'POST',headers:{'Content-Type':'application/json',...headers},
    body:JSON.stringify({candidate,revisions}),
  });
  return {r,data:await r.json()};
}
const store={
  public:async()=>snapshot().growth,
  complete:async()=>{throw Error('XP must never be awarded')},
  equip:async()=>{throw Error('Equipment must never be changed')},
};
test('server exposes active companion parameters with gear disabled and stable model revisions',async()=>{
  await withServer({loadSnapshot:async()=>snapshot(),companionStore:{
    read:async()=>companion,save:async()=>{throw Error('save forbidden')},
  },store},async base=>{
    const {r,data}=await get(base);
    assert.equal(r.status,200);
    assert.equal(data.source,'authored_companion');
    assert.equal(data.model.risk_fraction,.65);
    assert.equal(data.model.fast_window,3);
    assert.equal(data.model.slow_window,9);
    assert.deepEqual(data.model.plugin_weights,{trend:0,momentum:100,volatility:0,reversion:0});
    assert.deepEqual(data.model.plugin_strengths,strengths);
    assert.deepEqual(data.revisions,{source_revision:3,lineup_revision:2,
      growth_revision:5,companion_revision:7});
    const js=await fetch(base+'/model-lab-ui.mjs');
    assert.equal(js.status,200);
    assert.match(await js.text(),/labPresetBalanced/);
    const page=await fetch(base+'/game');
    assert.match(await page.text(),/変数の実験室/);
  });
});
test('same inputs tie exactly; different risk changes virtual capital usage but not predictions',async()=>{
  let predictionCalls=0;
  await withServer({
    loadSnapshot:async()=>snapshot(),companionStore:{read:async()=>companion},store,
    predict:async args=>{predictionCalls++;return pythonPredict(args);},
  },async base=>{
    const {data}=await get(base);
    const equal=await compare(base,data.model,data.revisions);
    assert.equal(equal.r.status,200,JSON.stringify(equal.data));
    assert.equal(equal.data.comparison_only,true);
    assert.equal(equal.data.save_performed,false);
    assert.equal(equal.data.xp_awarded,false);
    assert.equal(equal.data.holdout_evaluated,false);
    assert.equal(equal.data.live_market,false);
    assert.equal(equal.data.difference.different_signals,0);
    assert.equal(equal.data.difference.profit_coins,0);
    assert.equal(equal.data.difference.drawdown_pct,0);
    assert.deepEqual(equal.data.baseline.equity_path,equal.data.candidate.equity_path);
    assert.equal(equal.data.baseline.effective_sha256,equal.data.candidate.effective_sha256);
    const changed={...data.model,risk_fraction:.2};
    const riskOnly=await compare(base,changed,data.revisions);
    assert.equal(riskOnly.r.status,200,JSON.stringify(riskOnly.data));
    assert.deepEqual(riskOnly.data.baseline.signals,riskOnly.data.candidate.signals);
    assert.notDeepEqual(riskOnly.data.baseline.equity_path,riskOnly.data.candidate.equity_path);
    assert.notEqual(riskOnly.data.baseline.effective_sha256,riskOnly.data.candidate.effective_sha256);
    assert.equal(predictionCalls,2);
  });
});
test('changing weights runs one Python forecast and compares fixed synthetic decisions',async()=>{
  let plan;
  await withServer({
    loadSnapshot:async()=>snapshot(),companionStore:{read:async()=>companion},store,
    predict:async args=>{plan=args;return pythonPredict(args);},
  },async base=>{
    const {data}=await get(base);
    const candidate={...data.model,plugin_weights:{
      trend:50,momentum:30,volatility:10,reversion:10},fast_window:5,slow_window:12};
    const result=await compare(base,candidate,data.revisions);
    assert.equal(result.r.status,200,JSON.stringify(result.data));
    assert.deepEqual(plan.models.mine.plugin_weights,candidate.plugin_weights);
    assert.deepEqual(plan.models.owl.plugin_weights,data.model.plugin_weights);
    assert.deepEqual(plan.models.turtle.plugin_weights,data.model.plugin_weights);
    assert.equal(result.data.baseline.signals.length,12);
    assert.equal(result.data.candidate.signals.length,12);
    assert.equal(result.data.candidate.parameters.fast_window,5);
    assert.equal(result.data.candidate.parameters.slow_window,12);
    assert.equal(result.data.initial_coins_each,10000);
    assert.equal(result.data.fee_rate_pct,.1);
    assert.equal('training_ticket' in result.data,false);
  });
});
test('bad parameters and stale revisions are rejected without forecasting or writing',async()=>{
  const valid=model();
  for(const bad of [
    {...valid,fast_window:20,slow_window:20},
    {...valid,fast_window:1},
    {...valid,slow_window:21},
    {...valid,risk_fraction:1.01},
    {...valid,risk_fraction:0},
    {...valid,plugin_weights:{trend:70,momentum:20,volatility:0,reversion:0}},
    {...valid,plugin_strengths:{trend:49,momentum:100,volatility:100,reversion:100}},
    {...valid,plugin_weights:{...weights,unknown:0}},
    {...valid,extra:'not allowed'},
  ])assert.throws(()=>validateLabModel(bad),{status:400});
  assert.throws(()=>validateLabRevisions({source_revision:1}),{status:400});
  let predictions=0;
  await withServer({
    loadSnapshot:async()=>snapshot(),companionStore:{read:async()=>companion},store,
    predict:async()=>{predictions++;throw Error('unexpected forecast');},
  },async base=>{
    const {data}=await get(base);
    const stale={...data.revisions,companion_revision:data.revisions.companion_revision-1};
    assert.equal((await compare(base,data.model,stale)).r.status,409);
    assert.equal((await compare(base,{...data.model,risk_fraction:0},data.revisions)).r.status,400);
    const hostile=await compare(base,data.model,data.revisions,{Origin:'https://evil.invalid'});
    assert.equal(hostile.r.status,403);
    const extra=await fetch(base+'/api/model-lab/compare',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({candidate:data.model,revisions:data.revisions,auto_save:true})});
    assert.equal(extra.status,400);
    assert.equal(predictions,0);
  });
});
test('concurrent edits after prediction are detected before reporting a result',async()=>{
  let rev=3;
  await withServer({
    loadSnapshot:async()=>snapshot(rev),companionStore:{read:async()=>companion},
    predict:async args=>{const plan=await pythonPredict(args);rev++;return plan;},store,
  },async base=>{
    const {data}=await get(base);
    const r=await compare(base,data.model,data.revisions);
    assert.equal(r.r.status,409);
    assert.match(r.data.error,/版数/);
  });
});
test('pure model variable report rejects incomplete synthetic plans',()=>{
  assert.throws(()=>compareLabPlan({mode:'LIVE',future_prices:[],signals:[]},model(),model()),{status:503});
});

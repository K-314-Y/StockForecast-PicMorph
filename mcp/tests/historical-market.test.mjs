import test from 'node:test';
import assert from 'node:assert/strict';
import {createGameServer,pythonPredict} from '../../game_runtime/server.mjs';
import {compareHistoricalMarket} from '../../game_runtime/historical-market.mjs';
const MODEL_ID='mkt_'+'a'.repeat(24);
const weights={trend:100,momentum:0,volatility:0,reversion:0};
const strengths={trend:100,momentum:100,volatility:100,reversion:100};
const model=(adjust={})=>({
  fast_window:3,slow_window:9,risk_fraction:.35,
  plugin_weights:{...weights},plugin_strengths:{...strengths},...adjust,
});
const snapshot=(revision=3)=>({
  state:{revision,model:model()},
  lineup:{revision:1,slots:['owl','turtle'].map(slot=>({slot,model:model()}))},
  growth:{revision:6,slots:['mine','owl','turtle'].map(slot=>({slot,gear:'none'}))},
  source_revision:revision,lineup_revision:1,growth_revision:6,
});
const companion={revision:2,created:false,companion:null};
let writes=0;
const store={
  public:async()=>snapshot().growth,
  complete:async()=>{writes++;throw Error('XP forbidden')},
  equip:async()=>{writes++;throw Error('gear forbidden')},
};
const defaults={loadSnapshot:async()=>snapshot(),companionStore:{
  read:async()=>companion,save:async()=>{writes++;throw Error('save forbidden')},
},store};
async function serve(config,fn){
  const server=createGameServer({...defaults,...config});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  try{await fn('http://127.0.0.1:'+server.address().port);}
  finally{await new Promise(ok=>server.close(ok));}
}
const baseline=base=>fetch(base+'/api/model-lab/baseline').then(r=>r.json());
async function post(base,payload,headers={}){
  const response=await fetch(base+'/api/model-lab/historical',{
    method:'POST',headers:{'Content-Type':'application/json',...headers},
    body:JSON.stringify(payload),
  });
  return {response,data:await response.json()};
}
async function forecast(input){
  const {selection,...forecastInput}=input;
  const plan=await pythonPredict(forecastInput);
  return {
    mode:'HISTORICAL_MARKET_REPLAY_ONLY',source_origin:'LOCAL_JPX_REPORT_CACHE_2024',
    source:'JPX 2024 reports',source_warning:'Unadjusted local history',
    adjusted:false,market_id:MODEL_ID,code:'40050',
    start_date:'2024-01-04',history_end_date:'2024-02-08',end_date:'2024-02-26',
    lookback_days:24,future_days:12,eligible_windows:694,price_index_base:100,
    flat_threshold_pct:.3,
    brier:{mine:.64,owl:.73,turtle:.73},plan,
  };
}
test('historical replay compares same daily plan, with separate Brier and virtual-risk metrics; no writes',async()=>{
  writes=0;
  let count=0,observed=null;
  await serve({historicalPredict:async input=>{
    observed=input;count++;return forecast(input);
  }},async base=>{
    const first=await baseline(base);
    const candidate={...first.model,risk_fraction:.2};
    const request={candidate,revisions:first.revisions};
    const result=await post(base,request);
    assert.equal(result.response.status,200,JSON.stringify(result.data));
    const data=result.data;
    assert.equal(data.mode,'HISTORICAL_MARKET_REPLAY_ONLY');
    assert.equal(data.market.id,MODEL_ID);
    assert.equal(data.market.source_origin,'LOCAL_JPX_REPORT_CACHE_2024');
    assert.equal(data.market.adjusted,false);
    assert.equal(data.real_market_history,true);
    assert.equal(data.holdout_evaluated,false);
    assert.equal(data.xp_awarded,false);
    assert.equal(data.save_performed,false);
    assert.equal(data.baseline.brier,.73);
    assert.equal(data.candidate.brier,.64);
    assert.ok(data.difference.brier<0);
    assert.deepEqual(data.baseline.signals,data.candidate.signals,'risk only changes bankroll');
    assert.notDeepEqual(data.baseline.equity_path,data.candidate.equity_path);
    assert.equal(data.baseline.equity_path.length,13);
    assert.equal(data.candidate.equity_path.length,13);
    assert.equal(data.initial_coins_each,10000);
    assert.equal(data.fee_rate_pct,.1);
    assert.equal(observed.models.mine.risk_fraction,.2);
    assert.equal(observed.models.owl.risk_fraction,.35);
    assert.deepEqual(observed.selection,{});
    const replay=await post(base,{...request,replay_id:MODEL_ID});
    assert.equal(replay.response.status,200);
    assert.equal(observed.selection.replay_id,MODEL_ID);
    const exclude=await post(base,{...request,exclude_id:MODEL_ID});
    assert.equal(exclude.response.status,200);
    assert.equal(observed.selection.exclude_id,MODEL_ID);
    assert.equal(count,3);
    assert.equal(writes,0);
    assert.ok(!Object.hasOwn(data,'training_ticket'));
  });
});
test('invalid selection, origin and stale revision blocked before forecasting',async()=>{
  writes=0;
  let called=0;
  await serve({historicalPredict:async()=>{
    called++;throw Error('forecast must not be called');
  }},async base=>{
    const state=await baseline(base);
    const request={candidate:state.model,revisions:state.revisions};
    for(const bad of [
      {...request,replay_id:'bad'},
      {...request,exclude_id:'bad'},
      {...request,replay_id:MODEL_ID,exclude_id:MODEL_ID},
      {...request,save:true},
      {...request,candidate:{...state.model,fast_window:21}},
    ]){
      const r=await post(base,bad);
      assert.equal(r.response.status,400);
    }
    const badRev=await post(base,{...request,revisions:{...state.revisions,source_revision:99}});
    assert.equal(badRev.response.status,409);
    const cross=await post(base,request,{Origin:'https://evil.invalid'});
    assert.equal(cross.response.status,403);
    assert.equal(called,0);
    assert.equal(writes,0);
  });
});
test('mutating baseline while Python computes returns 409 without changing saved versions',async()=>{
  let revision=3;
  await serve({
    loadSnapshot:async()=>snapshot(revision),
    historicalPredict:async input=>{const result=await forecast(input);revision++;return result;},
  },async base=>{
    const state=await baseline(base);
    const result=await post(base,{candidate:state.model,revisions:state.revisions});
    assert.equal(result.response.status,409);
  });
});
test('historical market report rejects forged provenance and malformed plans',async()=>{
  const input={base_model:model(),models:{mine:model(),owl:model(),turtle:model()},selection:{}};
  const actual=await forecast(input);
  const tied=compareHistoricalMarket({...actual,brier:{mine:.5,owl:.5,turtle:.5}},model(),model());
  assert.equal(tied.difference.profit_coins,0);
  assert.equal(tied.difference.brier,0);
  const altered={...actual,source_origin:'UNKNOWN_API'};
  assert.throws(()=>compareHistoricalMarket(altered,model(),model()),{status:503});
  assert.throws(()=>compareHistoricalMarket({...actual,lookback_days:25},model(),model()),{status:503});
});

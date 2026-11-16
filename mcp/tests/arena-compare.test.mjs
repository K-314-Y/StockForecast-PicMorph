import test from 'node:test';
import assert from 'node:assert/strict';
import {createGameServer, pythonPredict} from '../../game_runtime/server.mjs';
import {makeFairComparison,validateContenders} from '../../game_runtime/arena.mjs';

const version='tv_'+'f'.repeat(32);
const draft='bp_'+'e'.repeat(32);
const weights={trend:100,momentum:0,volatility:0,reversion:0};
const strengths={trend:100,momentum:100,volatility:100,reversion:100};
const model=(w=weights)=>({fast_window:3,slow_window:9,risk_fraction:.4,
  plugin_weights:w,plugin_strengths:strengths});
const snapshot=(rev=3)=>({
  state:{revision:rev,model:model()},
  lineup:{revision:1,slots:[{slot:'owl',model:model({trend:0,momentum:100,volatility:0,reversion:0})},
    {slot:'turtle',model:model({trend:0,momentum:0,volatility:0,reversion:100})}]},
  growth:{revision:8,slots:[
    {slot:'mine',gear:'spark_charm'}, {slot:'owl',gear:'focus_lens'},
    {slot:'turtle',gear:'calm_halo'}]},
  source_revision:rev,lineup_revision:1,growth_revision:8,
});
const saved={created:true,revision:4,companion:{name:'私の研究モデル',
  hair_color:'#abcdef',clothing_color:'#abcdef',approach:'momentum',risk_percent:65}};
const trained=()=>({kind:'trained_practice_only',version_id:version,
  source_draft_id:draft,parameters_sha256:'a'.repeat(64),
  model:model({trend:0,momentum:0,volatility:100,reversion:0})});
async function serve(config,fn){
  const srv=createGameServer(config);
  await new Promise(resolve=>srv.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+srv.address().port;
  try {await fn(url);}finally{await new Promise(resolve=>srv.close(resolve));}
}
const post=(base,contenders,headers={})=>fetch(base+'/api/compare',{
  method:'POST',headers:{'Content-Type':'application/json',...headers},
  body:JSON.stringify({contenders}),
});
test('fair arena compares 3 real Python forecasts independently on one identical fixed scenario without XP',async()=>{
  let predicted=null,completions=0,versions=0;
  await serve({
    loadSnapshot:async()=>snapshot(),
    predict:async plan=>{predicted=plan;return pythonPredict(plan);},
    trainedVersion:async id=>{assert.equal(id,version);versions++;return trained();},
    companionStore:{read:async()=>saved,save:async()=>{completions++;throw Error('write forbidden');}},
    store:{public:async()=>snapshot().growth,complete:async()=>{completions++;throw Error('XP forbidden');},
      equip:async()=>{completions++;throw Error('gear forbidden');}},
  },async base=>{
    const contenders={mine:'self',owl:version,turtle:'preset'};
    const response=await post(base,contenders);
    assert.equal(response.status,200,await response.clone().text());
    const data=await response.json();
    assert.equal(data.mode,'PRACTICE_SYNTHETIC_ONLY');
    assert.equal(data.comparison_only,true);
    assert.equal(data.xp_awarded,false);
    assert.equal(data.gear_applied,false);
    assert.equal(data.scenario,'FIXED_SYNTHETIC_12');
    assert.equal(data.period_steps,12);
    assert.equal(data.initial_coins_per_model,10000);
    assert.equal(data.fee_rate_pct,.1);
    assert.equal(data.prices.length,13);
    assert.deepEqual([...data.ranking].sort(),['mine','owl','turtle'].sort());
    assert.equal(data.fighters.mine.kind,'authored_companion');
    assert.equal(data.fighters.mine.name,'私の研究モデル');
    assert.equal(data.fighters.owl.kind,'trained_practice_only');
    assert.equal(data.fighters.owl.version_id,version);
    assert.equal(data.fighters.turtle.kind,'preset_rival');
    assert.equal(predicted.models.mine.risk_fraction,.65);
    assert.deepEqual(predicted.models.mine.plugin_weights,{trend:0,momentum:100,volatility:0,reversion:0});
    assert.deepEqual(predicted.models.owl.plugin_weights,trained().model.plugin_weights);
    assert.deepEqual(predicted.models.mine.plugin_strengths,strengths,'legacy gear must not change authored model');
    assert.deepEqual(predicted.models.owl.plugin_strengths,strengths,'legacy gear must not change trained model');
    assert.deepEqual(predicted.models.turtle.plugin_strengths,strengths,'legacy gear must not change preset');
    assert.equal(data.fighters.mine.initial_coins,10000);
    assert.equal(data.fighters.owl.initial_coins,10000);
    assert.equal(data.fighters.turtle.initial_coins,10000);
    for(const fighter of Object.values(data.fighters)){
      assert.equal(fighter.equity_path.length,13);
      assert.equal(fighter.equity_path[0],10000);
      assert.equal(fighter.signals.length,12);
      assert.equal(fighter.fees>=0,true);
      assert.ok(Math.abs(fighter.final_coins-fighter.initial_coins-fighter.profit_coins)<.02);
    }
    assert.equal(completions,0,'comparison should never award XP or modify save');
    assert.equal(versions,2,'version must be checked before and after forecast');
    assert.equal(Object.hasOwn(data,'training_ticket'),false);
    const raw=await fetch(base+'/arena-ui.mjs');
    assert.equal(raw.status,200);
    assert.match(await raw.text(),/arenaRun/);
  });
});
test('up to 3 saved models are allowed; duplicate saved model and malformed requests rejected before predicting',async()=>{
  const ids=['a','b','c'].map(x=>'tv_'+x.repeat(32));
  assert.deepEqual(validateContenders({mine:ids[0],owl:ids[1],turtle:ids[2]}),
    {mine:ids[0],owl:ids[1],turtle:ids[2]});
  assert.throws(()=>validateContenders({mine:ids[0],owl:ids[0],turtle:'preset'}),{status:400});
  assert.throws(()=>validateContenders({mine:'preset',owl:'preset',turtle:'preset'}),{status:400});
  assert.throws(()=>validateContenders({mine:'self',owl:'preset',turtle:'preset',model:{}}),{status:400});
  let predictionCalls=0;
  await serve({predict:async()=>{predictionCalls++;throw Error('should not be invoked')}},
    async base=>{
      for(const body of [
        {contenders:{mine:'self',owl:version,turtle:version}},
        {contenders:{mine:'self',owl:'self',turtle:'preset'}},
        {contenders:{mine:'self',owl:'preset',turtle:'preset'},models:{}},
      ]){
        const r=await fetch(base+'/api/compare',{method:'POST',
          headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        assert.equal(r.status,400);
      }
      const r=await post(base,{mine:'self',owl:'preset',turtle:'preset'},
        {Origin:'https://evil.invalid'});
      assert.equal(r.status,403);
    });
  assert.equal(predictionCalls,0);
});
test('identical models tie under identical conditions, without manufacturing a winner',async()=>{
  const base=model();
  const plan=await pythonPredict({base_model:base,models:{
    mine:base,owl:base,turtle:base,
  }});
  const contestants={mine:'self',owl:'preset',turtle:'preset'};
  const meta=Object.fromEntries(['mine','owl','turtle'].map(slot=>
    [slot,{kind:'preset_rival',name:slot}]));
  const data=makeFairComparison(plan,contestants,meta);
  assert.equal(data.fighters.mine.final_coins,data.fighters.owl.final_coins);
  assert.equal(data.fighters.owl.final_coins,data.fighters.turtle.final_coins);
  assert.deepEqual(data.ranking,['mine','owl','turtle']);
  assert.equal(data.xp_awarded,false);
});
test('changes to trained parameters or core revision during prediction fail without a comparison',async()=>{
  let calls=0;
  await serve({loadSnapshot:async()=>snapshot(),
    companionStore:{read:async()=>saved},
    predict:pythonPredict,
    trainedVersion:async()=>{
      calls++;return {...trained(),parameters_sha256:(calls===1?'a':'b').repeat(64)};
    }},async base=>{
    const r=await post(base,{mine:'self',owl:version,turtle:'preset'});
    assert.equal(r.status,409);
  });
  let n=0;
  await serve({loadSnapshot:async()=>snapshot(++n),
    companionStore:{read:async()=>saved},predict:pythonPredict},
    async base=>{
      const r=await post(base,{mine:'self',owl:'preset',turtle:'preset'});
      assert.equal(r.status,409);
    });
});

test('three distinct trained versions replace all three slots without touching original loadouts',async()=>{
  const ids=['1','2','3'].map(x=>'tv_'+x.repeat(32));
  const types=[
    {trend:100,momentum:0,volatility:0,reversion:0},
    {trend:0,momentum:100,volatility:0,reversion:0},
    {trend:0,momentum:0,volatility:0,reversion:100},
  ];
  const configured=new Map(ids.map((id,i)=>[id,{
    ...trained(),version_id:id,parameters_sha256:String(i+1).repeat(64),
    model:model(types[i]),
  }]));
  const requested={mine:ids[0],owl:ids[1],turtle:ids[2]};
  const resolves=new Map(ids.map(id=>[id,0]));
  let observed=null;
  await serve({
    loadSnapshot:async()=>snapshot(),
    companionStore:{read:async()=>saved},
    trainedVersion:async id=>{
      resolves.set(id,(resolves.get(id)||0)+1);
      return configured.get(id);
    },
    predict:async plan=>{observed=plan;return pythonPredict(plan);},
  },async base=>{
    const response=await post(base,requested);
    assert.equal(response.status,200,await response.clone().text());
    const body=await response.json();
    assert.equal(body.comparison_only,true);
    for(const [slot,id] of Object.entries(requested)){
      assert.deepEqual(observed.models[slot].plugin_weights,configured.get(id).model.plugin_weights);
      assert.equal(body.fighters[slot].version_id,id);
      assert.equal(body.fighters[slot].initial_coins,10000);
      assert.equal(body.fighters[slot].equity_path.length,13);
      assert.equal(resolves.get(id),2);
    }
    assert.equal(body.fighters.mine.kind,'trained_practice_only');
    assert.equal(body.xp_awarded,false);
    assert.equal(Object.hasOwn(body,'training_ticket'),false);
  });
});

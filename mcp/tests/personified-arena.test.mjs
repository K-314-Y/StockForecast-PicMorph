import test from 'node:test';
import assert from 'node:assert/strict';
import {personaFromModel} from '../../game_runtime/arena.mjs';
import {createGameServer, pythonPredict} from '../../game_runtime/server.mjs';

const strengths={trend:100,momentum:100,volatility:100,reversion:100};
const weights=t=>Object.fromEntries(['trend','momentum','volatility','reversion'].map(k=>[k,k===t?100:0]));
const model=t=>({fast_window:3,slow_window:9,risk_fraction:.35,
  plugin_weights:weights(t),plugin_strengths:strengths});
const snapshot=()=>({state:{revision:4,model:model('trend')},
  lineup:{revision:3,slots:[{slot:'owl',model:model('momentum')},
    {slot:'turtle',model:model('reversion')}]},
  growth:{revision:2,slots:['mine','owl','turtle'].map(slot=>({slot,gear:'none'}))},
  source_revision:4,lineup_revision:3,growth_revision:2});
const companion={created:true,revision:2,companion:{
  name:'手作りの子',hair_color:'#123456',clothing_color:'#abcdef',
  approach:'volatility',risk_percent:55}};
const look={created:true,revision:3,look:{
  hair_style:'twintails',expression:'determined',accessory:'ribbon'}};
const chosen={mine:'self',owl:'preset',turtle:'preset'};

test('persona traits derive from real trained plugin weights, not rank or arbitrary score',()=>{
  for(const key of ['trend','momentum','reversion','volatility']){
    const a=personaFromModel(model(key));
    const b=personaFromModel(model(key));
    assert.equal(a.type,key);
    assert.equal(a.weights[key],100);
    assert.equal(a.risk_fraction,.35);
    assert.equal(a.look_source,'model_default');
    assert.deepEqual(a,b);
  }
  const blend=model('trend');
  blend.plugin_weights={trend:35,momentum:30,volatility:20,reversion:15};
  const result=personaFromModel(blend);
  assert.equal(result.type,'mixed');
  assert.equal(result.label,'複合タイプ');
  assert.deepEqual(result.weights,blend.plugin_weights);
  assert.throws(()=>personaFromModel({...blend,plugin_weights:{trend:101,momentum:-1,volatility:0,reversion:0}}));
  assert.throws(()=>personaFromModel({...blend,plugin_weights:{trend:100,momentum:0,volatility:0}}));
});
test('authored avatar uses player saved appearance but another model does not inherit those edits',async()=>{
  const server=createGameServer({
    loadSnapshot:async()=>snapshot(),
    predict:pythonPredict,
    companionStore:{read:async()=>companion},
    lookStore:{read:async()=>look},
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try {
    const r=await fetch(base+'/api/compare',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({contenders:chosen})});
    assert.equal(r.status,200,await r.clone().text());
    const data=await r.json();
    const mine=data.fighters.mine, owl=data.fighters.owl, turtle=data.fighters.turtle;
    assert.equal(mine.name,'手作りの子');
    assert.equal(mine.persona.type,'volatility');
    assert.equal(mine.persona.look.hair_color,'#123456');
    assert.equal(mine.persona.look.clothing_color,'#abcdef');
    assert.equal(mine.persona.look.hair_style,'twintails');
    assert.equal(mine.persona.look.expression,'determined');
    assert.equal(mine.persona.look.accessory,'ribbon');
    assert.equal(mine.persona.look_source,'player_saved');
    assert.equal(owl.persona.look_source,'model_default');
    assert.equal(turtle.persona.look_source,'model_default');
    assert.equal(owl.persona.type,'momentum');
    assert.equal(turtle.persona.type,'reversion');
    assert.equal(data.xp_awarded,false);
    assert.equal('training_ticket' in data,false);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('changing only the character look cannot change forecast decisions or virtual returns',async()=>{
  let activeLook=look;
  const server=createGameServer({
    loadSnapshot:async()=>snapshot(),predict:pythonPredict,
    companionStore:{read:async()=>companion},
    lookStore:{read:async()=>activeLook},
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base='http://127.0.0.1:'+server.address().port;
    const play=async()=>{
      const result=await fetch(base+'/api/compare',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({contenders:chosen})});
      assert.equal(result.status,200);
      return result.json();
    };
    const before=await play();
    activeLook={created:true,revision:4,look:{
      hair_style:'bob',expression:'calm',accessory:'star'}};
    const after=await play();
    for(const slot of ['mine','owl','turtle']){
      assert.deepEqual(before.fighters[slot].signals,after.fighters[slot].signals);
      assert.deepEqual(before.fighters[slot].equity_path,after.fighters[slot].equity_path);
      assert.equal(before.fighters[slot].effective_sha256,
        after.fighters[slot].effective_sha256);
    }
    assert.notEqual(before.fighters.mine.persona.look.hair_style,
      after.fighters.mine.persona.look.hair_style);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('distinct real model fingerprints give stable different 2D designs, without falsifying the same prediction type',()=>{
  const hashes=['54','69','f2'].map(prefix=>prefix+'0'.repeat(62));
  const profiles=hashes.map(effective_sha256=>
    personaFromModel({...model('trend'),effective_sha256}));
  assert.ok(profiles.every(p=>p.type==='trend'));
  assert.equal(new Set(profiles.map(p=>p.look.hair_style+'|'+p.look.hair_color)).size,3);
  assert.deepEqual(profiles[0],personaFromModel({...model('trend'),effective_sha256:hashes[0]}));
  assert.ok(profiles.every(p=>p.look_source==='model_default'));
});
